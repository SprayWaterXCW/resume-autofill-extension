import { normalizeAgentProfile } from "../../src/core/award-details.js";
import { importProfile, PRIVATE_PROFILE_KEY } from "../../src/core/profile-import.js";

// Personal values are returned only to our own editor, never to a content script.
export function isProfileEditorSender(sender, runtime) {
  const editorUrl = runtime.getURL("profile-editor.html");
  return sender?.id === runtime.id
    && (sender.url === editorUrl || sender.url?.startsWith(editorUrl + "#"));
}

function revisionOf(stored) {
  return stored ? stored.revision || "legacy:" + (stored.importedAt || "1") : null;
}

function editorSnapshot(stored, summary) {
  return {
    profile: normalizeAgentProfile(stored?.profile),
    revision: revisionOf(stored),
    savedAt: stored?.editedAt || stored?.importedAt || null,
    hasProfile: Boolean(stored),
    purpose: stored?.purpose || "personal_use",
    ...(summary ? { summary } : {}),
  };
}

export function createProfileStore({ storage, isBusy = () => false, onChanged = () => {} }) {
  let queue = Promise.resolve();
  let pendingWrites = 0;
  const readStored = async () => (await storage.get(PRIVATE_PROFILE_KEY))[PRIVATE_PROFILE_KEY];

  function mutate(work) {
    pendingWrites += 1;
    const operation = queue.then(async () => {
      if (isBusy()) throw new Error("PROFILE_EDITOR_BUSY");
      return work();
    }).finally(() => { pendingWrites -= 1; });
    // A rejected save must not stop later saves.
    queue = operation.catch(() => {});
    return operation;
  }

  async function persist(stored) {
    stored.revision = crypto.randomUUID();
    await storage.set({ [PRIVATE_PROFILE_KEY]: stored });
    await onChanged();
  }

  return {
    get isWriting() { return pendingWrites > 0; },
    async read() {
      await queue;
      return editorSnapshot(await readStored());
    },
    import(data) {
      return mutate(async () => {
        const { stored, summary } = importProfile(data);
        await persist(stored);
        return summary;
      });
    },
    save({ profile, baseRevision, purpose }) {
      return mutate(async () => {
        const current = await readStored();
        if (baseRevision !== revisionOf(current)) throw new Error("PROFILE_EDITOR_CONFLICT");
        if (!["personal_use", "synthetic_evaluation"].includes(purpose)) throw new Error("PROFILE_EDITOR_FORMAT");
        const { stored, summary } = importProfile({ profile, agentProfilePurpose: purpose });
        stored.editedAt = new Date().toISOString();
        if (current?.importedAt) stored.importedAt = current.importedAt;
        summary.importedAt = stored.importedAt;
        await persist(stored);
        return editorSnapshot(stored, summary);
      });
    },
  };
}
