/**
 * What this computer can run. The classes decide which models are offered; nothing is downloaded on the
 * strength of a guess, the person always sees the size and chooses.
 */

export type Gpu = 'none' | 'vulkan' | 'metal' | 'cuda' | 'webgpu' | 'unknown';
export type Os = 'windows' | 'macos' | 'linux' | 'android' | 'ios' | 'web';
export type Arch = 'x64' | 'arm64' | 'unknown';

export interface Hardware {
  ramGb: number;
  cores: number;
  gpu: Gpu;
  os: Os;
  arch: Arch;
  /** Free space where models are kept, when known. */
  freeDiskGb?: number;
}

/**
 * - `minimal`: under 6 GB. Rules only, and OCR with the small engine.
 * - `baseline`: the 8 GB laptop the product is sized for. 1 to 2 billion parameter models, 4-bit.
 * - `capable`: 16 GB, or a GPU. 3 to 4 billion.
 * - `strong`: 32 GB with a GPU. 7 to 8 billion.
 */
export type DeviceClass = 'minimal' | 'baseline' | 'capable' | 'strong';

export function classify(hw: Hardware): DeviceClass {
  const gpu = hw.gpu !== 'none' && hw.gpu !== 'unknown';
  if (hw.ramGb < 6 || hw.cores < 2) return 'minimal';
  if (hw.ramGb >= 28 && gpu) return 'strong';
  if (hw.ramGb >= 14 || (gpu && hw.ramGb >= 10)) return 'capable';
  return 'baseline';
}

/** Memory a model needs while it runs: its file, plus room for the context and the OCR engine beside it. */
export const RUN_OVERHEAD_GB = 1.5;

export function fits(hw: Hardware, modelSizeBytes: number): boolean {
  return modelSizeBytes / 2 ** 30 + RUN_OVERHEAD_GB <= hw.ramGb * 0.6;
}

/** `platform` strings used in the manifest: `linux-x64`, `windows-x64`, `macos-arm64`... */
export const platformKey = (hw: Pick<Hardware, 'os' | 'arch'>): string => `${hw.os}-${hw.arch}`;

interface NavigatorLike {
  deviceMemory?: number;
  hardwareConcurrency?: number;
  gpu?: unknown;
  userAgent?: string;
  platform?: string;
}

/** What a browser will say about the machine. `deviceMemory` is capped at 8 by browsers, so it is a floor. */
export function detectBrowserHardware(nav: NavigatorLike): Hardware {
  const ua = nav.userAgent ?? '';
  const os: Os = /android/i.test(ua)
    ? 'android'
    : /iphone|ipad/i.test(ua)
      ? 'ios'
      : /windows/i.test(ua)
        ? 'windows'
        : /mac os/i.test(ua)
          ? 'macos'
          : /linux/i.test(ua)
            ? 'linux'
            : 'web';
  const arch: Arch =
    /arm|aarch64/i.test(ua) || (os === 'macos' && /Macintosh/.test(ua) && !/Intel/.test(ua))
      ? 'arm64'
      : /x86_64|win64|x64|intel/i.test(ua)
        ? 'x64'
        : 'unknown';
  return {
    ramGb: nav.deviceMemory ?? 4,
    cores: nav.hardwareConcurrency ?? 2,
    gpu: nav.gpu ? 'webgpu' : 'unknown',
    os,
    arch,
  };
}
