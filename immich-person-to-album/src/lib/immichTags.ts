/* eslint-disable no-console */

export class ImmichTags {
  private apiKey: string;
  private baseUrl: string;

  constructor(apiKey: string, baseUrl: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl.replace(/\/+$/, "");
    if (!this.apiKey) throw new Error("ImmichTags requires apiKey");
    if (!this.baseUrl) throw new Error("ImmichTags requires baseUrl");
  }

  // --------- Public API ---------

  /** Ensure a tag exists, creating it if missing. Returns the tag id. */
  async ensure(name: string): Promise<string> {
    const existing = await this.findByName(name);
    if (existing?.id) return existing.id;

    const created = await this.create(name);
    console.log(`🏷️ Created tag "${name}" (${created.id})`);
    return created.id;
  }

  /**
   * Assign this tag to the provided assets (chunked).
   * Immich v2.x: PUT /api/tags/{id}/assets  body: { ids: string[] }
   */
  async addAssets(tagId: string, assetIds: string[]): Promise<void> {
    if (!Array.isArray(assetIds)) return;
    const ids = assetIds.filter(Boolean);
    if (ids.length === 0) return;

    const url = `${this.baseUrl}/api/tags/${tagId}/assets`;
    const groups = chunk(ids, 200);
    for (const group of groups) {
      if (group.length === 0) continue;
      await this.putNoContent(url, { ids: group }); // <<<<< key fix here
      console.log(`🏷️ Tagged ${group.length} asset(s) with tag ${tagId}`);
    }
  }

  // --------- Internals ---------

  private headersJSON(): Record<string, string> {
    return {
      Accept: "application/json",
      "Content-Type": "application/json",
      "x-api-key": this.apiKey,
      "x-immich-api-key": this.apiKey,
    };
  }

  private async getJson<T = any>(url: string): Promise<T> {
    const res = await fetch(url, { headers: this.headersJSON() });
    if (!res.ok) {
      const txt = await safeText(res);
      throw new Error(`GET ${url} -> ${res.status} ${res.statusText} :: ${txt}`);
    }
    return (await res.json()) as T;
  }

  private async postJson<T = any>(url: string, body: any): Promise<T> {
    const res = await fetch(url, {
      method: "POST",
      headers: this.headersJSON(),
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const txt = await safeText(res);
      throw new Error(
        `POST ${url} -> ${res.status} ${res.statusText} :: ${txt}`,
      );
    }
    return (await res.json().catch(() => ({}))) as T;
  }

  private async putNoContent(url: string, body: any): Promise<void> {
    const res = await fetch(url, {
      method: "PUT",
      headers: this.headersJSON(),
      body: JSON.stringify(body ?? {}),
    });
    if (!res.ok) {
      const txt = await safeText(res);
      throw new Error(
        `PUT ${url} -> ${res.status} ${res.statusText} :: ${txt}`,
      );
    }
  }

  private async findByName(
    name: string,
  ): Promise<{ id: string; name: string } | null> {
    const url = `${this.baseUrl}/api/tags`;
    try {
      const list = (await this.getJson<any[]>(url)) || [];
      const found =
        list.find(
          (t) =>
            typeof t?.name === "string" &&
            t.name.trim().toLowerCase() === name.trim().toLowerCase(),
        ) || null;
      return found ? { id: String(found.id), name: String(found.name) } : null;
    } catch (err) {
      console.warn(
        `findByName failed for "${name}": ${(err as Error).message}`,
      );
      return null;
    }
  }

  private async create(
    name: string,
  ): Promise<{ id: string; name: string }> {
    const url = `${this.baseUrl}/api/tags`;
    const body = { name };
    const created = await this.postJson<any>(url, body);
    const id = String(created?.id ?? created?.tagId ?? "");
    if (!id) throw new Error(`Tag creation returned no id for "${name}"`);
    return { id, name: String(created?.name ?? name) };
  }
}

// --------- helpers ---------
function chunk<T>(arr: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) out.push(arr.slice(i, i + size));
  return out;
}

async function safeText(res: Response): Promise<string> {
  try {
    return await res.text();
  } catch {
    return "";
  }
}
