// Optional pi-knowledge integration for the home screen. pi-knowledge is a separate package;
// load its lib from wherever it is installed, and quietly do without it if it isn't.
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

let cached: any = undefined;

export async function loadKnowledge(): Promise<any | undefined> {
  if (cached !== undefined) return cached || undefined;
  const dirs = [
    process.env.PI_KNOWLEDGE_LIB,
    join(homedir(), ".pi", "agent", "git", "github.com", "nimishgj", "pi-knowledge", "lib"),
    join(homedir(), "github", "pi-knowledge", "lib"),
  ].filter(Boolean) as string[];
  for (const d of dirs) {
    const f = join(d, "index.ts");
    if (!existsSync(f)) continue;
    try {
      cached = await import(pathToFileURL(f).href);
      return cached;
    } catch {
      /* try the next location */
    }
  }
  cached = null;
  return undefined;
}
