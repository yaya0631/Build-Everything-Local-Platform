// Assistant settings kept in this browser: the model and whether the model
// may see a small preview of the image. Light: menus read it at startup.
/** The model configured in Everything Settings, listed for the Assistant menu. */
export type AssistantModel = { id: string; label: string; note: string };

/** The empty id means "Automatic": let the server use the model chosen in Settings. */
export const AUTO_MODEL = '';
export const ASSISTANT_MODELS: AssistantModel[] = [];
export const DEFAULT_ASSISTANT_MODEL = AUTO_MODEL;
const KEY = 'photo-studio-assistant';

export const assistantSettings = { model: DEFAULT_ASSISTANT_MODEL, seeImage: true };
try {
  const v = JSON.parse(globalThis.localStorage?.getItem(KEY) ?? '{}') as Partial<typeof assistantSettings>;
  // The saved id is accepted only once the configured list confirms it below.
  if (typeof v.model === 'string') assistantSettings.model = v.model;
  if (typeof v.seeImage === 'boolean') assistantSettings.seeImage = v.seeImage;
} catch {
  /* Settings are optional. */
}
export function saveAssistantSettings() {
  try {
    globalThis.localStorage?.setItem(KEY, JSON.stringify(assistantSettings));
  } catch {
    /* Settings are optional. */
  }
}

type EverythingSDK = { ai?: { listModels?: (options?: { capability?: string }) => Promise<unknown> } };
let loading: Promise<boolean> | null = null;
let loaded = false;

/**
 * Load the chat models configured in Settings. Resolves false when the list
 * cannot be fetched (signed out, offline, or no SDK); an empty list is a
 * successful fetch and means no provider exposes a model. Stale saved ids are
 * discarded so the menu never offers a model the server cannot run.
 */
export function loadAssistantModels(): Promise<boolean> {
  if (loaded) return Promise.resolve(true);
  if (loading) return loading;
  loading = (async () => {
    const sdk = (globalThis as unknown as { everything?: EverythingSDK }).everything;
    if (typeof sdk?.ai?.listModels !== 'function') return false;
    try {
      const list = await sdk.ai.listModels({ capability: 'chat' });
      if (!Array.isArray(list)) return false;
      const models: AssistantModel[] = [];
      for (const item of list) {
        const m = (item && typeof item === 'object' ? item : {}) as Record<string, unknown>;
        const id = String(m.id ?? m.name ?? '').trim();
        if (!id || models.some((existing) => existing.id === id)) continue;
        models.push({ id, label: String(m.name ?? id), note: String(m.provider ?? 'Configured') });
      }
      ASSISTANT_MODELS.splice(0, ASSISTANT_MODELS.length, ...models);
      if (assistantSettings.model && !models.some((m) => m.id === assistantSettings.model)) {
        assistantSettings.model = AUTO_MODEL;
        saveAssistantSettings();
      }
      loaded = true;
      return true;
    } catch {
      return false;
    }
  })().finally(() => {
    loading = null;
  });
  return loading;
}

export const modelLabel = (id: string) =>
  !id ? 'Automatic' : ASSISTANT_MODELS.find((m) => m.id === id)?.label ?? id;
/** What a request sends, as the panel and the start screen say it. */
export const sentNote = (hasDocument: boolean) =>
  `Sends your request${hasDocument ? `, the document’s size and layer list${assistantSettings.seeImage ? ' and a small preview' : ''}` : ''} to Everything’s AI service (Everything account; may use credits).`;
