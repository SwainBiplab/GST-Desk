import { LanDeviceRepo, type Ctx, type Database, type LanDeviceRow } from '@gst/db';
import type { Device, DeviceStore } from '@gst/lan';

const toDevice = (r: LanDeviceRow): Device => ({ ...r });

/** Paired devices kept in the desktop's own database, for the bridge. */
export class DbDeviceStore implements DeviceStore {
  private readonly repo: LanDeviceRepo;
  constructor(
    d: Database,
    private readonly ctx: Ctx,
  ) {
    this.repo = new LanDeviceRepo(d);
  }
  list = async () => (await this.repo.devices(this.ctx)).map(toDevice);
  findByHash = async (hash: string, now: number) => {
    const r = await this.repo.findByHash(this.ctx, hash, now);
    return r ? toDevice(r) : null;
  };
  save = (d: Device) => this.repo.save(this.ctx, d);
}
