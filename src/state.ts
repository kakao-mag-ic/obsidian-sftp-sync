import localforage from "localforage";
import type { SyncRecord } from "./types";

const STORE_NAME = "sftp-sync-records";

export class SyncState {
  private store: LocalForage;

  constructor() {
    this.store = localforage.createInstance({
      name: STORE_NAME,
    });
  }

  async load(): Promise<Map<string, SyncRecord>> {
    const records = new Map<string, SyncRecord>();
    const keys = await this.store.keys();
    for (const key of keys) {
      const record = await this.store.getItem<SyncRecord>(key);
      if (record) {
        records.set(key, record);
      }
    }
    return records;
  }

  async save(records: Map<string, SyncRecord>): Promise<void> {
    await this.store.clear();
    for (const [key, record] of records) {
      await this.store.setItem(key, record);
    }
  }

  async getRecord(path: string): Promise<SyncRecord | null> {
    return await this.store.getItem<SyncRecord>(path);
  }

  async setRecord(path: string, record: SyncRecord): Promise<void> {
    await this.store.setItem(path, record);
  }

  async deleteRecord(path: string): Promise<void> {
    await this.store.removeItem(path);
  }

  async clear(): Promise<void> {
    await this.store.clear();
  }
}
