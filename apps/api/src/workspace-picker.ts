import { execFile } from 'node:child_process';

interface CommandResult {
  stdout: string;
  stderr: string;
}

interface CommandError extends Error {
  code?: number | string;
  stderr?: string;
}

function runCommand(command: string, args: string[]): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    execFile(command, args, { encoding: 'utf8' }, (error, stdout, stderr) => {
      if (error) {
        const commandError = error as CommandError;
        commandError.stderr = stderr;
        reject(commandError);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

export type NativeWorkspacePicker = () => Promise<string | undefined>;

export async function pickNativeWorkspaceDirectory(): Promise<string | undefined> {
  let command: string;
  let args: string[];

  switch (process.platform) {
    case 'darwin':
      command = 'osascript';
      args = [
        '-e',
        'POSIX path of (choose folder with prompt "选择 One Agent 会话工作区")',
      ];
      break;
    case 'win32':
      command = 'powershell.exe';
      args = [
        '-NoProfile',
        '-STA',
        '-Command',
        [
          'Add-Type -AssemblyName System.Windows.Forms',
          '$dialog = New-Object System.Windows.Forms.FolderBrowserDialog',
          "$dialog.Description = '选择 One Agent 会话工作区'",
          'if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK)',
          '{ [Console]::Out.Write($dialog.SelectedPath) } else { exit 2 }',
        ].join('; '),
      ];
      break;
    case 'linux':
      command = 'zenity';
      args = [
        '--file-selection',
        '--directory',
        '--title=选择 One Agent 会话工作区',
      ];
      break;
    default:
      throw new Error(`当前系统暂不支持原生目录选择：${process.platform}`);
  }

  try {
    const result = await runCommand(command, args);
    const selected = result.stdout.trim();
    return selected || undefined;
  } catch (error) {
    const commandError = error as CommandError;
    const detail = `${commandError.message}\n${commandError.stderr ?? ''}`;
    const cancelled =
      (process.platform === 'darwin' && /User canceled|-128/i.test(detail)) ||
      (process.platform === 'win32' && Number(commandError.code) === 2) ||
      (process.platform === 'linux' && Number(commandError.code) === 1);
    if (cancelled) return undefined;
    if (commandError.code === 'ENOENT') {
      throw new Error(`当前系统缺少目录选择程序：${command}`);
    }
    throw new Error(`无法打开系统目录选择器：${commandError.message}`);
  }
}
