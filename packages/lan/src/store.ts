import type { Role } from './roles';

export interface Device {
  id: string;
  name: string;
  platform: string;
  role: Role;
  tokenHash: string;
  /** Epoch ms the current token was made; it is replaced after 30 days. */
  tokenIssuedAt: number;
  /** The token before the last rotation, still accepted for a short grace. */
  prevTokenHash: string | null;
  prevValidUntil: number;
  createdAt: number;
  lastSeenAt: number | null;
  revokedAt: number | null;
}

/** Where paired devices are kept. The desktop keeps them in its database; tests keep them in memory. */
export interface DeviceStore {
  list(): Promise<Device[]>;
  /** The device whose current token has this hash, or whose previous token has it and is still in its grace. */
  findByHash(hash: string, now: number): Promise<Device | null>;
  save(device: Device): Promise<void>;
}

export class MemoryDeviceStore implements DeviceStore {
  readonly devices = new Map<string, Device>();
  list = async () => [...this.devices.values()];
  findByHash = async (hash: string, now: number) =>
    [...this.devices.values()].find(
      (d) => d.tokenHash === hash || (d.prevTokenHash === hash && d.prevValidUntil > now),
    ) ?? null;
  save = async (d: Device) => {
    this.devices.set(d.id, { ...d });
  };
}
