import { execFileSync, spawn } from 'node:child_process';
import os from 'node:os';

/**
 * 原生系统文件选择对话框
 *
 * - Windows：PowerShell + System.Windows.Forms / Shell COM
 *   用 `-EncodedCommand`（UTF-16LE Base64）传脚本，规避命令行代码页对中文参数/中文标题的破坏；
 *   脚本内强制 `[Console]::OutputEncoding = UTF8`，结果直接走 stdout，保证中文路径不乱码。
 *   选文件夹走 `IFileOpenDialog` + `FOS_PICKFOLDERS`，窗口标题可自定义；
 *   COM 不可用时回退到 `FolderBrowserDialog`（标题为系统默认「浏览文件夹」）。
 *   选压缩包走 `OpenFileDialog`（多选）。
 * - macOS：osascript（choose folder / choose file with multiple selections allowed）
 * - Linux：优先 zenity，缺失时降级 kdialog
 */

export type DialogMode = 'dir' | 'zip';

/** 单个平台的对话框执行器：返回选中的路径；多选时用换行分隔；取消返回 null */
type DialogRunner = (mode: DialogMode, title: string, initialDir?: string | null) => string | null;

/** Windows 上依次尝试的 PowerShell（Windows PowerShell 优先，缺失时用 PowerShell 7） */
const PS_BINARIES = ['powershell.exe', 'pwsh.exe', 'pwsh'];

const ZIP_FILTER = '瓦片压缩包 (*.zip)|*.zip|所有文件 (*.*)|*.*';

/** 文件夹选择对话框的确认按钮文案 */
const OK_LABEL = '选择此文件夹';

/** PowerShell 单引号转义，避免中文标题/路径把脚本弄坏 */
const quote = (text: string): string => text.replace(/'/g, "''");

/**
 * C# 互操作：调用 Vista 之后的 `IFileOpenDialog`（`FOS_PICKFOLDERS`）。
 *
 * 相比 `FolderBrowserDialog`，它支持自定义窗口标题与「选择此文件夹」按钮文案，
 * 并且是资源管理器的现代样式。接口按 vtable 顺序扁平声明（IFileDialog 的方法在前，
 * IFileOpenDialog 追加的 GetResults / GetSelectedItems 在后），与 CLSID 返回的接口一致。
 */
const FOLDER_PICKER_CS = `using System;
using System.Runtime.InteropServices;

public static class TileMergerFolderPicker
{
    [ComImport, Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IShellItem
    {
        void BindToHandler(IntPtr pbc, ref Guid bhid, ref Guid riid, out IntPtr ppv);
        void GetParent(out IShellItem ppsi);
        void GetDisplayName(uint sigdnName, [MarshalAs(UnmanagedType.LPWStr)] out string ppszName);
        void GetAttributes(uint sfgaoMask, out uint psfgaoAttribs);
        void Compare(IShellItem psi, uint hint, out int piOrder);
    }

    [ComImport, Guid("d57c7288-d4ad-4768-be02-9d969532d960"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    internal interface IFileOpenDialog
    {
        [PreserveSig] int Show(IntPtr parent);
        void SetFileTypes(uint cFileTypes, IntPtr rgFilterSpec);
        void SetFileTypeIndex(uint iFileType);
        void GetFileTypeIndex(out uint piFileType);
        void Advise(IntPtr pfde, out uint pdwCookie);
        void Unadvise(uint dwCookie);
        void SetOptions(uint fos);
        void GetOptions(out uint pfos);
        void SetDefaultFolder(IShellItem psi);
        void SetFolder(IShellItem psi);
        void GetFolder(out IShellItem ppsi);
        void GetCurrentSelection(out IShellItem ppsi);
        void SetFileName([MarshalAs(UnmanagedType.LPWStr)] string pszName);
        void GetFileName([MarshalAs(UnmanagedType.LPWStr)] out string pszName);
        void SetTitle([MarshalAs(UnmanagedType.LPWStr)] string pszTitle);
        void SetOkButtonLabel([MarshalAs(UnmanagedType.LPWStr)] string pszText);
        void SetFileNameLabel([MarshalAs(UnmanagedType.LPWStr)] string pszLabel);
        void GetResult(out IShellItem ppsi);
        void AddPlace(IShellItem psi, uint fdap);
        void SetDefaultExtension([MarshalAs(UnmanagedType.LPWStr)] string pszDefaultExtension);
        void Close(int hr);
        void SetClientGuid(ref Guid guid);
        void ClearClientData();
        void SetFilter(IntPtr pFilter);
        void GetResults(out IntPtr ppenum);
        void GetSelectedItems(out IntPtr ppsai);
    }

    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHCreateItemFromParsingName(
        [MarshalAs(UnmanagedType.LPWStr)] string pszPath,
        IntPtr pbc,
        ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IShellItem ppv);

    [DllImport("ole32.dll", PreserveSig = false)]
    static extern void CoCreateInstance(
        ref Guid rclsid,
        IntPtr pUnkOuter,
        uint dwClsContext,
        ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IFileOpenDialog ppv);

    const uint CLSCTX_INPROC_SERVER = 0x1;
    const uint FOS_PICKFOLDERS = 0x00000020;
    const uint FOS_FORCEFILESYSTEM = 0x00000040;
    const uint FOS_PATHMUSTEXIST = 0x00000800;
    const uint SIGDN_FILESYSPATH = 0x80058000;

    public static string Pick(string title, string initialDirectory, string okLabel)
    {
        Guid clsid = new Guid("DC1C5A9C-E88A-4dde-A5A1-60F82A20AEF7");
        Guid iid = new Guid("d57c7288-d4ad-4768-be02-9d969532d960");

        IFileOpenDialog dialog;
        CoCreateInstance(ref clsid, IntPtr.Zero, CLSCTX_INPROC_SERVER, ref iid, out dialog);

        try
        {
            uint options;
            dialog.GetOptions(out options);
            dialog.SetOptions(options | FOS_PICKFOLDERS | FOS_FORCEFILESYSTEM | FOS_PATHMUSTEXIST);

            if (!String.IsNullOrEmpty(title)) dialog.SetTitle(title);
            if (!String.IsNullOrEmpty(okLabel)) dialog.SetOkButtonLabel(okLabel);

            if (!String.IsNullOrEmpty(initialDirectory))
            {
                try
                {
                    IShellItem start;
                    Guid itemIid = new Guid("43826d1e-e718-42ee-bc55-a1e261c37bfe");
                    SHCreateItemFromParsingName(initialDirectory, IntPtr.Zero, ref itemIid, out start);
                    dialog.SetFolder(start);
                    Marshal.ReleaseComObject(start);
                }
                catch
                {
                    // 起始目录不存在等情况直接忽略，对话框从默认位置打开
                }
            }

            // Show 返回 HRESULT：0 = 确定，其余（如 0x800704C7）视为取消
            if (dialog.Show(IntPtr.Zero) != 0) return null;

            IShellItem result;
            dialog.GetResult(out result);
            try
            {
                string path;
                result.GetDisplayName(SIGDN_FILESYSPATH, out path);
                return path;
            }
            finally
            {
                Marshal.ReleaseComObject(result);
            }
        }
        finally
        {
            Marshal.ReleaseComObject(dialog);
        }
    }
}`;

/** 选文件夹：现代 IFileOpenDialog，失败时回退 FolderBrowserDialog */
function windowsFolderScript(title: string, initialDir: string | null): string {
  const lines = [
    '$ErrorActionPreference = "Stop";',
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {};',
    '$picked = $null;',
    '$modern = $true;',
    'try {',
    "if (-not ('TileMergerFolderPicker' -as [type])) {",
    "Add-Type -TypeDefinition @'",
    FOLDER_PICKER_CS,
    "'@",
    '};',
    `$picked = [TileMergerFolderPicker]::Pick('${quote(title)}', '${quote(initialDir ?? '')}', '${quote(OK_LABEL)}');`,
    '} catch { $modern = $false };',
    'if (-not $modern) {',
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$Dialog = New-Object System.Windows.Forms.FolderBrowserDialog;',
    `$Dialog.Description = '${quote(title)}';`,
    '$Dialog.ShowNewFolderButton = $true;',
    'if ($Dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $picked = $Dialog.SelectedPath };',
    '};',
    'if ($picked) { [Console]::Out.Write($picked) }',
  ];
  return lines.join('\n');
}

/** 选压缩包：OpenFileDialog（多选） */
function windowsZipScript(title: string): string {
  const lines = [
    '$ErrorActionPreference = "Stop";',
    'try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {};',
    'Add-Type -AssemblyName System.Windows.Forms;',
    '$Dialog = New-Object System.Windows.Forms.OpenFileDialog;',
    `$Dialog.Title = '${quote(title)}';`,
    `$Dialog.Filter = '${ZIP_FILTER}';`,
    '$Dialog.Multiselect = $true;',
    'if ($Dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { [Console]::Out.Write(($Dialog.FileNames -join "`n")) }',
  ];
  return lines.join('\n');
}

/** Windows：编码后交给 PowerShell 执行，结果从 stdout 读回 */
function runWindows(mode: DialogMode, title: string, initialDir?: string | null): string | null {
  const script =
    mode === 'dir' ? windowsFolderScript(title, initialDir ?? null) : windowsZipScript(title);
  const encoded = Buffer.from(script, 'utf16le').toString('base64');

  for (const binary of PS_BINARIES) {
    try {
      const out = execFileSync(
        binary,
        ['-NoProfile', '-NonInteractive', '-STA', '-EncodedCommand', encoded],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] },
      );
      return out.trim() || null;
    } catch (error) {
      // 解释器不存在 → 尝试下一个；用户取消 / 脚本报错 → 视为未选择
      if ((error as NodeJS.ErrnoException)?.code !== 'ENOENT') return null;
    }
  }
  return null;
}

/** macOS：osascript */
function runMac(mode: DialogMode, title: string): string | null {
  const prompt = title.replace(/"/g, '\\"');
  const args =
    mode === 'dir'
      ? ['-e', `POSIX path of (choose folder with prompt "${prompt}")`]
      : [
          '-e',
          `set chosen to choose file with prompt "${prompt}" of type {"zip"} with multiple selections allowed`,
          '-e',
          'set out to ""',
          '-e',
          'repeat with f in chosen',
          '-e',
          'set out to out & (POSIX path of f) & linefeed',
          '-e',
          'end repeat',
          '-e',
          'return out',
        ];

  const out = execFileSync('osascript', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  }).trim();
  return out || null;
}

/** Linux：按候选顺序尝试（未安装的跳过，全部失败按未选择处理） */
function tryCommands(commands: string[][]): string | null {
  for (const [command, ...args] of commands) {
    try {
      const out = execFileSync(command, args, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }).trim();
      return out || null;
    } catch {
      // 未安装 / 用户取消 → 尝试下一个候选
    }
  }
  return null;
}

/** Linux：zenity 优先，缺失时 kdialog */
function runLinux(mode: DialogMode, title: string, initialDir?: string | null): string | null {
  if (mode === 'dir') {
    return tryCommands([
      ['zenity', '--file-selection', '--directory', `--title=${title}`, ...(initialDir ? [`--filename=${initialDir}`] : [])],
      ['kdialog', '--getexistingdirectory', initialDir || '.', '--title', title],
    ]);
  }
  return tryCommands([
    [
      'zenity',
      '--file-selection',
      '--multiple',
      '--separator=\n',
      `--title=${title}`,
      '--file-filter=瓦片压缩包 | *.zip',
    ],
    ['kdialog', '--getopenfilename', '.', '*.zip', '--title', title],
  ]);
}

const RUNNERS: Record<string, DialogRunner> = {
  win32: runWindows,
  darwin: runMac,
  linux: runLinux,
};

/** 把多行输出拆成路径列表（兼容 CRLF 与空行） */
const splitLines = (text: string): string[] =>
  text
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

/**
 * 当前平台是否支持弹出系统对话框。
 * Linux 桌面不一定安装 zenity / kdialog，缺失时命令会失败，由调用方按「用户取消」处理。
 */
export const isDialogSupported = (): boolean => os.platform() in RUNNERS;

/** 是否禁用原生对话框（无 GUI 环境 / 显式关闭） */
export function dialogDisabled(): boolean {
  const flag = process.env.TILE_MERGER_NO_DIALOG;
  return flag === '1' || flag === 'true';
}

/**
 * 弹出系统对话框选择文件夹。
 *
 * @param title        对话框标题（Windows 走 IFileOpenDialog，标题可自定义）
 * @param initialDir   打开时的起始目录（Windows / Linux 生效）
 * @returns 选中的绝对路径；用户取消或平台不支持时返回 null
 */
export function pickDirectory(
  title = '请选择瓦片图层文件夹',
  initialDir?: string | null,
): string | null {
  if (dialogDisabled()) return null;
  const runner = RUNNERS[os.platform()];
  if (!runner) return null;

  try {
    const out = runner('dir', title, initialDir);
    return out ? (splitLines(out)[0] ?? null) : null;
  } catch {
    // 用户取消 / 命令不可用，统一按未选择处理
    return null;
  }
}

/**
 * 弹出系统对话框选择压缩包（Windows / macOS 支持多选）。
 *
 * @returns 选中的绝对路径列表；用户取消或平台不支持时返回空数组
 */
export function pickZipFiles(title = '请选择瓦片图层压缩包（可多选）'): string[] {
  if (dialogDisabled()) return [];
  const runner = RUNNERS[os.platform()];
  if (!runner) return [];

  try {
    const out = runner('zip', title);
    return out ? splitLines(out) : [];
  } catch {
    return [];
  }
}

/**
 * 用系统文件管理器打开目录。
 * 命令以独立进程启动，不阻塞，也不随 CLI 退出而关闭。
 */
export function openInFileManager(dir: string): boolean {
  const platform = os.platform();
  const [command, args] =
    platform === 'win32'
      ? ['explorer.exe', [dir]]
      : platform === 'darwin'
        ? ['open', [dir]]
        : ['xdg-open', [dir]];

  try {
    const child = spawn(command, args, { detached: true, stdio: 'ignore' });
    child.unref();
    return true;
  } catch {
    return false;
  }
}
