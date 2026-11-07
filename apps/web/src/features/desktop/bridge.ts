/**
 * The web app's way to the desktop shell. Everything here is a thin call to a Rust command (see
 * `apps/desktop/src-tauri/src`); none of it exists in a browser, where `isDesktop()` is false.
 */
import { invoke } from '@tauri-apps/api/core';
import { listen, type UnlistenFn } from '@tauri-apps/api/event';

export const isDesktop = () => typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface DataPaths {
  root: string;
  db: string;
  backups: string;
  documents: string;
  logs: string;
  isDefault: boolean;
}

export interface UpdateInfo {
  version: string;
  current: string;
  notes: string | null;
  date: string | null;
}

export type LaunchRequest = { kind: 'file'; value: string } | { kind: 'link'; value: string };

export const dataPaths = () => invoke<DataPaths>('data_paths');
export const openDataDir = () => invoke<null>('open_data_dir');
export const moveData = (target: string) => invoke<DataPaths>('move_data', { target });
export const removeRestoreDir = (name: string) => invoke<null>('remove_restore_dir', { name });
export const listPrinters = () => invoke<string[]>('list_printers');
export const diagnosticsZip = (dest: string, extra?: string) =>
  invoke<number>('diagnostics_zip', { dest, extra });

export const updateCheck = (channel: string, baseUrl?: string) =>
  invoke<UpdateInfo | null>('update_check', { channel, baseUrl });
export const updateDownload = () => invoke<null>('update_download');
export const updateInstall = () => invoke<null>('update_install');

export const takeLaunchRequests = () => invoke<LaunchRequest[]>('take_launch_requests');
export const readBackupFile = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await invoke<ArrayBuffer>('read_backup_file', { path }));
export const setTrayLabels = (labels: Record<string, string>) =>
  invoke<null>('set_tray_labels', { labels });

export interface LanStarted {
  port: number;
  fingerprint: string;
  addresses: string[];
}
export const lanStart = (port: number) => invoke<LanStarted>('lan_start', { args: { port } });
export const lanStop = () => invoke<null>('lan_stop');
export const lanReply = (id: number, status: number, body: string) =>
  invoke<boolean>('lan_reply', { id, status, body });

/** Offline AI (prompt 36): model files under the data folder, and the sidecar servers. All `ai_*`
 * commands answer `not_built` when the app was built without the `ai` cargo feature. */
export const aiModelsDir = () => invoke<string>('ai_models_dir');
export const aiFileSize = (file: string) => invoke<number | null>('ai_file_size', { file });
export const aiAppend = (file: string, base64: string) =>
  invoke<null>('ai_append', { file, base64 });
export const aiRemove = (file: string) => invoke<null>('ai_remove', { file });
export const aiFinish = (partial: string, file: string) =>
  invoke<null>('ai_finish', { partial, file });
export const aiSha256 = (file: string) => invoke<string>('ai_sha256', { file });
export const aiReadText = (file: string) => invoke<string | null>('ai_read_text', { file });
export const aiWriteText = (file: string, text: string) =>
  invoke<null>('ai_write_text', { file, text });
export const aiFreeBytes = () => invoke<number | null>('ai_free_bytes');
export const aiListDir = (dir: string) =>
  invoke<{ name: string; size: number; modified: number }[]>('ai_list_dir', { dir });
export const aiReadFile = async (path: string): Promise<Uint8Array> =>
  new Uint8Array(await invoke<ArrayBuffer>('ai_read_file', { path }));
export const aiHardware = () =>
  invoke<{ ramGb: number; cores: number; gpu: string; os: string; arch: string }>('ai_hardware');
export const sidecarStart = (kind: string, modelFile: string, threads?: number) =>
  invoke<{ baseUrl: string }>('sidecar_start', { kind, modelFile, threads: threads ?? null });
export const sidecarStop = (kind: string) => invoke<null>('sidecar_stop', { kind });

export function on<T = unknown>(event: string, handler: (payload: T) => void): Promise<UnlistenFn> {
  return listen<T>(event, (e) => handler(e.payload));
}

/** The folder part of a path, for either kind of separator. */
export function dirname(path: string): string {
  const i = Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\'));
  return i < 0 ? '' : path.slice(0, i);
}

export const basename = (path: string): string =>
  path.slice(Math.max(path.lastIndexOf('/'), path.lastIndexOf('\\')) + 1);
