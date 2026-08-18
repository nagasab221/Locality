import { useEffect, useState } from "react";
import { get, post } from "../api";
import type { ListItem } from "../types";
import { btnPrimary, inputCls, Modal } from "./ui";

export interface CollectionCard {
  key: string; // "tmdb:<id>" (automatic box set) or "man:<id>" (manual)
  name: string;
  count: number;
  poster: string | null;
}

/** Add an item to a manual collection (create one inline if needed). */
export function CollectionPickDialog({
  item,
  onClose,
  onDone,
}: {
  item: ListItem;
  onClose: () => void;
  onDone: () => void;
}) {
  const [collections, setCollections] = useState<CollectionCard[]>([]);
  const [newName, setNewName] = useState("");
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  useEffect(() => {
    get<CollectionCard[]>("/collections")
      .then((all) => setCollections(all.filter((c) => c.key.startsWith("man:"))))
      .catch(() => {});
  }, []);

  const addTo = (manualId: number) => {
    setBusy(true);
    post(`/collections/${manualId}/items`, { itemId: item.id })
      .then(() => {
        onDone();
        onClose();
      })
      .catch((e) => setErr(String(e.message ?? e)))
      .finally(() => setBusy(false));
  };

  const createAndAdd = () => {
    if (!newName.trim()) return;
    setBusy(true);
    post<{ id: number }>("/collections", { name: newName.trim() })
      .then((c) => addTo(c.id))
      .catch((e) => {
        setErr(String(e.message ?? e));
        setBusy(false);
      });
  };

  return (
    <Modal onClose={onClose}>
      <div className="p-5 space-y-4">
        <h3 className="font-display text-lg text-heading">Add “{item.title}” to a collection</h3>
        {collections.length > 0 && (
          <div className="space-y-1.5">
            {collections.map((c) => (
              <button
                key={c.key}
                disabled={busy}
                onClick={() => addTo(+c.key.slice(4))}
                className="w-full text-left px-3 py-2 rounded-md border border-cardborder hover:border-accent hover:bg-raised transition-colors text-sm text-body"
              >
                {c.name} <span className="text-muted text-xs">· {c.count} titles</span>
              </button>
            ))}
          </div>
        )}
        <div className="flex gap-2">
          <input
            className={inputCls}
            placeholder="New collection name…"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && createAndAdd()}
          />
          <button className={btnPrimary} disabled={busy || !newName.trim()} onClick={createAndAdd}>
            Create
          </button>
        </div>
        <p className="text-[11px] text-muted leading-relaxed">
          Movie box sets appear automatically. Use manual collections to group anything else.
        </p>
        {err && <p className="text-danger text-sm">{err}</p>}
      </div>
    </Modal>
  );
}
