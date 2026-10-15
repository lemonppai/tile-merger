import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * 原生系统文件选择对话框。
 * 参照 har-gen-api 的做法：Windows 走 PowerShell + System.Windows.Forms，
 * macOS 走 osascript，Linux 走 zenity。
 *
 * 结果通过临时文件回传（UTF-8），避免控制台编码把中文路径搞乱。
 */

export type DialogMode = 'dir' | 'zip';

const TIMEOUT = 5 * 60 * 1000;

/** 是否禁用原生对话框（无 GUI 环境 / 显式关闭） */
export function dialogDisabled(): boolean {
  const flag = process.env.TILE_MERGER_NO_DIALOG;
  return flag === '1' || flag === 'true';
}

function tempFile(suffix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tile-merger-dlg-'));
  return path.join(dir, `result${suffix}`);
}

function readLines(file: string): string[] {
  if (!fs.existsSync(file)) return [];
  return fs
    .readFileSync(file, 'utf8')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

/** 在系统文件管理器中打开某个目录 */
export function openInFileManager(dir: string): void {
  try {
    if (process.platform === 'win32') {
      // explorer.exe 打开成功时也可能返回非 0 退出码，忽略退出状态
      execFile('explorer.exe', [dir], () => undefined);
    } else if (process.platform === 'darwin') {
      execFile('open', [dir], () => undefined);
    } else {
      execFile('xdg-open', [dir], () => undefined);
    }
  } catch {
    // 打开失败不影响主流程
  }
}

/** 在 Windows 上依次尝试 powershell.exe / pwsh */
function runPowerShell(script: string, resultFile: string): boolean {
  const candidates = ['powershell.exe', 'pwsh.exe', 'pwsh'];
  for (const bin of candidates) {
    try {
      execFileSync(
        bin,
        ['-NoProfile', '-NonInteractive', '-STA', '-ExecutionPolicy', 'Bypass', '-Command', script],
        {
          stdio: ['ignore', 'ignore', 'ignore'],
          timeout: TIMEOUT,
          env: { ...process.env, TM_RESULT_FILE: resultFile },
        },
      );
      return true;
    } catch {
      // 换下一个解释器
    }
  }
  return false;
}

const PS_FOLDER = `Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.FolderBrowserDialog
$dialog.Description = '请选择瓦片图层文件夹'
$dialog.ShowNewFolderButton = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllText($env:TM_RESULT_FILE, $dialog.SelectedPath, [System.Text.Encoding]::UTF8)
}`;

const PS_ZIP = `Add-Type -AssemblyName System.Windows.Forms | Out-Null
$dialog = New-Object System.Windows.Forms.OpenFileDialog
$dialog.Title = '请选择瓦片图层压缩包（可多选）'
$dialog.Filter = '瓦片压缩包 (*.zip)|*.zip|所有文件 (*.*)|*.*'
$dialog.Multiselect = $true
if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) {
  [System.IO.File]::WriteAllLines($env:TM_RESULT_FILE, $dialog.FileNames, [System.Text.Encoding]::UTF8)
}`;

/** 弹出原生对话框选择文件夹；取消或失败返回 null */
export function pickDirectory(title = '请选择瓦片图层文件夹'): string | null {
  if (dialogDisabled()) return null;

  if (process.platform === 'win32') {
    const resultFile = tempFile('.txt');
    if (!runPowerShell(PS_FOLDER, resultFile)) return null;
    return readLines(resultFile)[0] ?? null;
  }

  if (process.platform === 'darwin') {
    try {
      const out = execFileSync(
        'osascript',
        ['-e', `POSIX path of (choose folder with prompt "${title}")`],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: TIMEOUT },
      ).trim();
      return out || null;
    } catch {
      return null;
    }
  }

  try {
    const out = execFileSync(
      'zenity',
      ['--file-selection', '--directory', `--title=${title}`],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: TIMEOUT },
    ).trim();
    return out || null;
  } catch {
    return null;
  }
}

/** 弹出原生对话框选择 zip 文件（支持多选）；取消或失败返回空数组 */
export function pickZipFiles(title = '请选择瓦片图层压缩包'): string[] {
  if (dialogDisabled()) return [];

  if (process.platform === 'win32') {
    const resultFile = tempFile('.txt');
    if (!runPowerShell(PS_ZIP, resultFile)) return [];
    return readLines(resultFile);
  }

  if (process.platform === 'darwin') {
    try {
      const out = execFileSync(
        'osascript',
        [
          '-e',
          `set chosen to choose file with prompt "${title}" of type {"zip"} with multiple selections allowed`,
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
        ],
        { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: TIMEOUT },
      );
      return out
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);
    } catch {
      return [];
    }
  }

  try {
    const out = execFileSync(
      'zenity',
      ['--file-selection', '--multiple', '--separator=\n', `--title=${title}`, '--file-filter=瓦片压缩包 | *.zip'],
      { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: TIMEOUT },
    );
    return out
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}
