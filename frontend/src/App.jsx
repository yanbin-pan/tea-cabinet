import React, { useState, useEffect, useMemo, useCallback } from "react";
import { Search, Plus, X, Leaf, Pencil, Trash2, Save, MapPin, Calendar, Droplet, Award, Camera, Upload, Loader2, AlertCircle, Check, Download, FileUp, Zap, Layers } from "lucide-react";

const TEA_TYPES = ["Green", "White", "Yellow", "Oolong", "Black", "Dark", "Pu-erh", "Scented", "Herbal", "Other"];

const TYPE_COLORS = {
  Green:   { bg: "#E7EFDD", fg: "#3B5220", dot: "#6E9438" },
  White:   { bg: "#EFEDE4", fg: "#5A5647", dot: "#B0A98C" },
  Yellow:  { bg: "#F5EBCE", fg: "#6B571C", dot: "#C9A62E" },
  Oolong:  { bg: "#EDE2CF", fg: "#6A4E23", dot: "#B7833B" },
  Black:   { bg: "#EADAD2", fg: "#5C3A2A", dot: "#9E5A3C" },
  Dark:    { bg: "#DFD6CC", fg: "#463A2E", dot: "#7A6248" },
  "Pu-erh":{ bg: "#DCD0C2", fg: "#403123", dot: "#6E5137" },
  Scented: { bg: "#F1E3EA", fg: "#6A3A50", dot: "#B25E86" },
  Herbal:  { bg: "#E4EDE6", fg: "#33513C", dot: "#5E9068" },
  Other:   { bg: "#E8E6E0", fg: "#4A473F", dot: "#928C7C" },
};

const GRADES = ["Everyday", "Standard", "Premium", "Competition", "Imperial / Gong Ting"];
const RARITY = ["Common", "Uncommon", "Rare", "Very rare"];
const STORAGE_KEY = "cha:collection:v2";

const BLANK = { id: null, englishName: "", chineseName: "", type: "", flavourNotes: "", brewTemp: "", steepTime: "", origin: "", harvestYear: "", rarity: "", grade: "", caffeine: "", reasoning: "", photo: null, createdAt: null };

const SEED = [];

// Same-origin in production (nginx proxies /api to the backend); override for
// split deployments with VITE_API_BASE at build time.
const API_BASE = import.meta.env.VITE_API_BASE || "";

async function persist(collection) {
  const json = JSON.stringify(collection);
  // Synchronous mirror first: this write completes immediately, so it survives
  // even if the page is refreshed before the network write below finishes.
  try { if (window.localStorage) window.localStorage.setItem(STORAGE_KEY, json); } catch (e) {}
  // Durable store: the backend's JSON file on its mounted volume.
  try {
    await fetch(`${API_BASE}/api/collection`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ teas: collection }),
    });
  } catch (e) {}
}
async function hydrate() {
  // Prefer the backend; fall back to the local mirror only when it's unreachable
  // (covers an offline reload — the mirror is never authoritative otherwise).
  try {
    const res = await fetch(`${API_BASE}/api/collection`);
    if (res.ok) {
      const data = await res.json();
      if (data && Array.isArray(data.teas)) return data.teas;
    }
  } catch (e) {
    try {
      if (window.localStorage) {
        const raw = window.localStorage.getItem(STORAGE_KEY);
        if (raw) return JSON.parse(raw);
      }
    } catch (e2) {}
  }
  return null;
}

// Monotonic unique id — timestamp + counter + randomness, so IDs minted in the
// same millisecond (e.g. a bulk import loop) can never collide.
let _idCounter = 0;
function uniqueId() { return `t-${Date.now()}-${(_idCounter++).toString(36)}-${Math.random().toString(36).slice(2, 6)}`; }

export default function App() {
  const [collection, setCollection] = useState([]);
  const [ready, setReady] = useState(false);
  const [query, setQuery] = useState("");
  const [typeFilter, setTypeFilter] = useState("All");
  const [editing, setEditing] = useState(null);
  const [detail, setDetail] = useState(null);
  const [toast, setToast] = useState(null);

  useEffect(() => {
    let alive = true;
    (async () => {
      let data = await hydrate();
      if (!Array.isArray(data)) { data = SEED; }
      // Backfill any fields added in later versions (e.g. caffeine) so older
      // records don't carry undefined values into the edit form.
      data = data.map((t) => ({ ...BLANK, ...t }));
      if (alive) { setCollection(data); setReady(true); }
    })();
    return () => { alive = false; };
  }, []);

  const showToast = useCallback((msg, kind = "ok") => {
    setToast({ msg, kind });
    setTimeout(() => setToast(null), 2600);
  }, []);

  const save = useCallback((draft) => {
    setCollection((prev) => {
      let next;
      if (draft.id && prev.some((t) => t.id === draft.id)) next = prev.map((t) => (t.id === draft.id ? draft : t));
      else { const rec = { ...draft, id: draft.id || uniqueId(), createdAt: draft.createdAt || Date.now() }; next = [rec, ...prev]; }
      persist(next);
      return next;
    });
    setEditing(null);
    showToast(draft.id ? "Tea updated" : "Tea added to your collection");
  }, [showToast]);

  const remove = useCallback((id) => {
    setCollection((prev) => { const next = prev.filter((t) => t.id !== id); persist(next); return next; });
    setDetail(null);
    showToast("Removed from collection");
  }, [showToast]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return collection.filter((t) => {
      if (typeFilter !== "All" && t.type !== typeFilter) return false;
      if (!q) return true;
      return [t.englishName, t.chineseName, t.flavourNotes, t.origin, t.type, t.grade, t.rarity, t.harvestYear].join(" ").toLowerCase().includes(q);
    });
  }, [collection, query, typeFilter]);

  const typeCounts = useMemo(() => {
    const m = { All: collection.length };
    for (const t of collection) m[t.type] = (m[t.type] || 0) + 1;
    return m;
  }, [collection]);

  const activeTypes = ["All", ...TEA_TYPES.filter((t) => typeCounts[t])];

  const exportJson = useCallback(() => {
    if (collection.length === 0) { showToast("Nothing to export yet", "err"); return; }
    try {
      const payload = { app: "The Tea Cabinet", version: 1, exportedAt: new Date().toISOString(), teas: collection };
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: "application/json" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      const stamp = new Date().toISOString().slice(0, 10);
      a.href = url; a.download = `tea-cabinet-${stamp}.json`;
      document.body.appendChild(a); a.click(); document.body.removeChild(a);
      URL.revokeObjectURL(url);
      showToast(`Exported ${collection.length} ${collection.length === 1 ? "tea" : "teas"}`);
    } catch (e) { showToast("Export failed", "err"); }
  }, [collection, showToast]);

  const importJson = useCallback(async (e) => {
    const file = e.target.files && e.target.files[0];
    e.target.value = "";
    if (!file) return;
    try {
      const text = await file.text();
      const data = JSON.parse(text);
      const incoming = Array.isArray(data) ? data : data.teas;
      if (!Array.isArray(incoming)) throw new Error("bad shape");
      setCollection((prev) => {
        const byId = new Map(prev.map((t) => [t.id, t]));
        let updated = 0, addedNew = 0;
        for (const raw of incoming) {
          if (!raw || (!raw.englishName && !raw.chineseName)) continue;
          const rec = { ...BLANK, ...raw };
          if (rec.id && byId.has(rec.id)) {
            // Same ID as an existing tea: update it in place (merge over old).
            rec.createdAt = rec.createdAt || byId.get(rec.id).createdAt || Date.now();
            byId.set(rec.id, rec); updated++;
          } else {
            // New tea (or missing id): give it a guaranteed-unique id.
            if (!rec.id) rec.id = uniqueId();
            if (!rec.createdAt) rec.createdAt = Date.now();
            byId.set(rec.id, rec); addedNew++;
          }
        }
        const next = Array.from(byId.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
        persist(next);
        const parts = [];
        if (addedNew) parts.push(`${addedNew} added`);
        if (updated) parts.push(`${updated} updated`);
        showToast(`Import complete — ${parts.length ? parts.join(", ") : "no teas found"}`);
        return next;
      });
    } catch (err) { showToast("Couldn't read that file — expected a Tea Cabinet export", "err"); }
  }, [showToast]);

  const dedupe = useCallback(() => {
    setCollection((prev) => {
      const seen = new Map();
      // Collapse duplicates: same id first, otherwise same english+chinese name.
      for (const t of prev) {
        const key = t.id || `${(t.englishName || "").trim().toLowerCase()}|${(t.chineseName || "").trim().toLowerCase()}`;
        const existing = seen.get(key);
        // Keep the richer record (prefer one that has a caffeine value / more fields).
        if (!existing) { seen.set(key, t); continue; }
        const score = (x) => Object.values(x).filter((v) => v !== "" && v != null).length;
        seen.set(key, score(t) >= score(existing) ? t : existing);
      }
      const next = Array.from(seen.values()).sort((a, b) => (b.createdAt || 0) - (a.createdAt || 0));
      const removed = prev.length - next.length;
      persist(next);
      showToast(removed > 0 ? `Removed ${removed} duplicate ${removed === 1 ? "tea" : "teas"}` : "No duplicates found");
      return next;
    });
  }, [showToast]);

  return (
    <div style={S.root}>
      <style>{CSS}</style>
      <header style={S.header}>
        <div style={S.brandRow}>
          <div style={S.mark}><span style={S.markHanzi}>茶</span></div>
          <div>
            <h1 style={S.h1}>The Tea Cabinet</h1>
            <p style={S.sub}>A personal inventory of Chinese tea · {collection.length} {collection.length === 1 ? "entry" : "entries"}</p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 10, flexWrap: "wrap" }}>
          <label className="btn" style={{ cursor: "pointer" }}>
            <FileUp size={15} /> Import
            <input type="file" accept="application/json,.json" onChange={importJson} style={{ display: "none" }} />
          </label>
          <button className="btn" onClick={exportJson}><Download size={15} /> Export</button>
          {collection.length > 1 && <button className="btn" onClick={dedupe} title="Merge duplicate entries"><Layers size={15} /> Dedupe</button>}
          <button className="btn btn-primary" onClick={() => setEditing({ ...BLANK })}><Plus size={16} strokeWidth={2.2} /> Add tea</button>
        </div>
      </header>

      <div style={S.controls}>
        <div style={S.searchWrap}>
          <Search size={17} style={{ color: "#9a9482", flexShrink: 0 }} />
          <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search name, flavour, origin…" style={S.search} className="tea-search" />
          {query && <button className="clear-x" onClick={() => setQuery("")} aria-label="Clear search"><X size={15} /></button>}
        </div>
        <div style={S.chips}>
          {activeTypes.map((t) => {
            const active = typeFilter === t; const c = TYPE_COLORS[t];
            return (
              <button key={t} onClick={() => setTypeFilter(t)} className="chip" style={{ ...S.chip, ...(active ? S.chipActive : {}), ...(active && c ? { background: c.bg, color: c.fg, borderColor: c.dot } : {}) }}>
                {c && <span style={{ ...S.chipDot, background: c.dot }} />}{t}<span style={S.chipCount}>{typeCounts[t] || 0}</span>
              </button>
            );
          })}
        </div>
      </div>

      {!ready ? (
        <div style={S.empty}><Loader2 className="spin" size={22} /><span style={{ marginTop: 10 }}>Opening the cabinet…</span></div>
      ) : filtered.length === 0 ? (
        <EmptyState hasAny={collection.length > 0} onAdd={() => setEditing({ ...BLANK })} onClear={() => { setQuery(""); setTypeFilter("All"); }} />
      ) : (
        <div style={S.grid}>{filtered.map((tea) => <TeaCard key={tea.id} tea={tea} onOpen={() => setDetail(tea)} />)}</div>
      )}

      {editing && <EditModal draft={editing} onClose={() => setEditing(null)} onSave={save} onToast={showToast} />}
      {detail && <DetailModal tea={detail} onClose={() => setDetail(null)} onEdit={() => { setEditing(detail); setDetail(null); }} onDelete={() => remove(detail.id)} />}
      {toast && <div style={{ ...S.toast, ...(toast.kind === "err" ? S.toastErr : {}) }}>{toast.kind === "err" ? <AlertCircle size={16} /> : <Check size={16} />} {toast.msg}</div>}
    </div>
  );
}

function TeaCard({ tea, onOpen }) {
  const c = TYPE_COLORS[tea.type] || TYPE_COLORS.Other;
  return (
    <button className="tea-card" style={S.card} onClick={onOpen}>
      <div style={{ ...S.cardTop, background: c.bg }}>
        {tea.photo ? <img src={tea.photo} alt="" style={S.cardImg} /> : <span style={{ ...S.cardHanzi, color: c.fg }}>{firstHanzi(tea.chineseName) || <Leaf size={30} color={c.dot} />}</span>}
        <span style={{ ...S.typeTag, background: c.dot }}>{tea.type || "—"}</span>
        {tea.grade && <span style={S.gradeTag}>{tea.grade}</span>}
      </div>
      <div style={S.cardBody}>
        <div style={S.cardNames}>
          <span style={S.cardEn}>{tea.englishName || "Untitled tea"}</span>
          {tea.chineseName && <span style={S.cardZh}>{tea.chineseName}</span>}
        </div>
        {tea.flavourNotes && <p style={S.cardFlavour}>{tea.flavourNotes}</p>}
        <div style={S.cardMeta}>
          {tea.origin && <span style={S.metaItem}><MapPin size={12} /> {shorten(tea.origin, 22)}</span>}
          {tea.harvestYear && <span style={S.metaItem}><Calendar size={12} /> {tea.harvestYear}</span>}
        </div>
      </div>
    </button>
  );
}

function EmptyState({ hasAny, onAdd, onClear }) {
  return (
    <div style={S.empty}>
      <div style={S.emptyMark}>茶</div>
      {hasAny ? (
        <><p style={S.emptyTitle}>No teas match that</p><p style={S.emptySub}>Try a different search or clear the filters.</p><button className="btn" onClick={onClear} style={{ marginTop: 4 }}>Clear filters</button></>
      ) : (
        <><p style={S.emptyTitle}>The cabinet is empty</p><p style={S.emptySub}>Add your first tea by hand, or snap a photo of the packet to fill it in.</p><button className="btn btn-primary" onClick={onAdd} style={{ marginTop: 4 }}><Plus size={16} /> Add your first tea</button></>
      )}
    </div>
  );
}

function EditModal({ draft, onClose, onSave, onToast }) {
  const [form, setForm] = useState(draft);
  const [scanning, setScanning] = useState(false);
  const [scanError, setScanError] = useState(null);
  const [scanned, setScanned] = useState(false);
  const set = (k, v) => setForm((f) => ({ ...f, [k]: v }));

  const onFile = async (e) => {
    const file = e.target.files && e.target.files[0];
    if (!file) return;
    setScanError(null); setScanned(false);
    if (file.type && file.type.indexOf("image/") !== 0 && !/\.(jpe?g|png|gif|webp|heic|heif)$/i.test(file.name || "")) {
      setScanError("That doesn't look like an image. Upload a JPEG, PNG, or photo of the packet.");
      e.target.value = ""; return;
    }
    try {
      const raw = await fileToDataUrl(file);
      // Re-encode to a clean, size-bounded JPEG before storing or scanning.
      const dataUrl = await normalizeImage(raw);
      set("photo", dataUrl);
      await runScan(dataUrl);
    } catch (err) { setScanError((err && err.message) || "Couldn't read that file. Try another photo."); }
    e.target.value = "";
  };

  const runScan = async (dataUrl) => {
    setScanning(true); setScanError(null);
    try {
      const parsed = await readLabelWithClaude(dataUrl);
      setForm((f) => ({ ...f,
        englishName: parsed.englishName || f.englishName,
        chineseName: parsed.chineseName || f.chineseName,
        type: parsed.type || f.type,
        flavourNotes: parsed.flavourNotes || f.flavourNotes,
        brewTemp: parsed.brewTemp || f.brewTemp,
        steepTime: parsed.steepTime || f.steepTime,
        origin: parsed.origin || f.origin,
        harvestYear: parsed.harvestYear || f.harvestYear,
        rarity: parsed.rarity || f.rarity,
        grade: parsed.grade || f.grade,
        reasoning: parsed.reasoning || f.reasoning,
      }));
      setScanned(true);
      onToast("Label read — review the fields below", "ok");
    } catch (err) { setScanError(err.message || "Couldn't read that label. Fill the fields in by hand."); }
    finally { setScanning(false); }
  };

  const submit = () => {
    if (!form.englishName.trim() && !form.chineseName.trim()) { setScanError("Give the tea at least an English or Chinese name."); return; }
    onSave(form);
  };

  const c = TYPE_COLORS[form.type] || TYPE_COLORS.Other;
  return (
    <Overlay onClose={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={S.modalHead}>
          <h2 style={S.modalTitle}>{draft.id ? "Edit tea" : "Add a tea"}</h2>
          <button className="icon-btn" onClick={onClose} aria-label="Close"><X size={18} /></button>
        </div>
        <div style={S.modalScroll}>
          <div style={{ ...S.intake, background: c.bg }}>
            {form.photo ? <img src={form.photo} alt="Tea packet" style={S.intakeImg} /> : <div style={S.intakeIcon}><Camera size={26} color={c.dot} /></div>}
            <div style={{ flex: 1 }}>
              <p style={S.intakeTitle}>Read the label</p>
              <p style={S.intakeSub}>Upload a photo of the packet and Claude will translate the Chinese and fill in the fields for you to review.</p>
              <div style={S.intakeBtns}>
                <label className="btn btn-small" style={{ cursor: "pointer" }}>
                  <Upload size={14} /> {form.photo ? "Replace photo" : "Upload photo"}
                  <input type="file" accept="image/*" onChange={onFile} style={{ display: "none" }} />
                </label>
                {form.photo && !scanning && <button className="btn btn-small" onClick={() => runScan(form.photo)}><Camera size={14} /> Re-read</button>}
              </div>
            </div>
          </div>

          {scanning && <div style={S.scanState}><Loader2 className="spin" size={16} /> Reading the label — translating and grading…</div>}
          {scanned && !scanning && <div style={{ ...S.scanState, ...S.scanOk }}><Check size={16} /> Fields filled from the label. Edit anything below before saving.</div>}
          {scanError && <div style={{ ...S.scanState, ...S.scanErr }}><AlertCircle size={16} /> {scanError}</div>}

          <div style={S.fieldGrid}>
            <Field label="English name" full><input value={form.englishName} onChange={(e) => set("englishName", e.target.value)} placeholder="Dragon Well" className="fld" /></Field>
            <Field label="Chinese name 中文名" full><input value={form.chineseName} onChange={(e) => set("chineseName", e.target.value)} placeholder="西湖龙井" className="fld" /></Field>
            <Field label="Tea type"><select value={form.type} onChange={(e) => set("type", e.target.value)} className="fld"><option value="">Choose…</option>{TEA_TYPES.map((t) => <option key={t} value={t}>{t}</option>)}</select></Field>
            <Field label="Harvest year"><input value={form.harvestYear} onChange={(e) => set("harvestYear", e.target.value)} placeholder="2024" className="fld" /></Field>
            <Field label="Flavour notes" full><textarea value={form.flavourNotes} onChange={(e) => set("flavourNotes", e.target.value)} placeholder="Chestnut, fresh grass, gentle sweetness" className="fld" rows={2} /></Field>
            <Field label="Water temp (°C)"><input value={form.brewTemp} onChange={(e) => set("brewTemp", e.target.value)} placeholder="80" className="fld" /></Field>
            <Field label="Steep time"><input value={form.steepTime} onChange={(e) => set("steepTime", e.target.value)} placeholder="1–2 min" className="fld" /></Field>
            <Field label="Caffeine / gaiwan cup"><input value={form.caffeine} onChange={(e) => set("caffeine", e.target.value)} placeholder="~30 mg" className="fld" /></Field>
            <Field label="Origin" full><input value={form.origin} onChange={(e) => set("origin", e.target.value)} placeholder="West Lake, Hangzhou, Zhejiang" className="fld" /></Field>
            <Field label="Grade"><select value={form.grade} onChange={(e) => set("grade", e.target.value)} className="fld"><option value="">Unknown</option>{GRADES.map((g) => <option key={g} value={g}>{g}</option>)}</select></Field>
            <Field label="Rarity"><select value={form.rarity} onChange={(e) => set("rarity", e.target.value)} className="fld"><option value="">Choose…</option>{RARITY.map((r) => <option key={r} value={r}>{r}</option>)}</select></Field>
            <Field label="Grading reasoning" full><textarea value={form.reasoning} onChange={(e) => set("reasoning", e.target.value)} placeholder="Why this grade / rarity — from the label and general knowledge of Chinese tea grading." className="fld" rows={2} /></Field>
          </div>
        </div>
        <div style={S.modalFoot}>
          <button className="btn" onClick={onClose}>Cancel</button>
          <button className="btn btn-primary" onClick={submit}><Save size={15} /> {draft.id ? "Save changes" : "Save to collection"}</button>
        </div>
      </div>
    </Overlay>
  );
}

function DetailModal({ tea, onClose, onEdit, onDelete }) {
  const [confirm, setConfirm] = useState(false);
  const c = TYPE_COLORS[tea.type] || TYPE_COLORS.Other;
  return (
    <Overlay onClose={onClose}>
      <div style={S.modal} onClick={(e) => e.stopPropagation()}>
        <div style={{ ...S.detailHero, background: c.bg }}>
          <button className="icon-btn" style={S.detailClose} onClick={onClose} aria-label="Close"><X size={18} /></button>
          {tea.photo ? <img src={tea.photo} alt="" style={S.detailImg} /> : <span style={{ ...S.detailHanzi, color: c.fg }}>{firstHanzi(tea.chineseName) || (tea.englishName && tea.englishName[0]) || "茶"}</span>}
        </div>
        <div style={S.modalScroll}>
          <div style={S.detailNames}>
            <div><h2 style={S.detailEn}>{tea.englishName || "Untitled tea"}</h2>{tea.chineseName && <p style={S.detailZh}>{tea.chineseName}</p>}</div>
            <span style={{ ...S.typeTagLg, background: c.dot }}>{tea.type || "—"}</span>
          </div>
          {(tea.grade || tea.rarity) && (
            <div style={S.badges}>
              {tea.grade && <span style={S.gradeBadge}><Award size={13} /> {tea.grade}</span>}
              {tea.rarity && <span style={{ ...S.rarityBadge, ...rarityStyle(tea.rarity) }}>{tea.rarity}</span>}
            </div>
          )}
          {tea.flavourNotes && <Section title="Flavour"><p style={S.sectionText}>{tea.flavourNotes}</p></Section>}
          <Section title="Brewing">
            <div style={S.brewRow}>
              <div style={S.brewCell}><Droplet size={16} color={c.dot} /><span style={S.brewVal}>{tea.brewTemp ? `${tea.brewTemp}°C` : "—"}</span><span style={S.brewLbl}>water</span></div>
              <div style={S.brewCell}><Calendar size={16} color={c.dot} /><span style={S.brewVal}>{tea.steepTime || "—"}</span><span style={S.brewLbl}>steep</span></div>
              {tea.caffeine && <div style={S.brewCell}><Zap size={16} color={c.dot} /><span style={S.brewVal}>{tea.caffeine}</span><span style={S.brewLbl}>caffeine / cup</span></div>}
            </div>
          </Section>
          <CaffeineContext tea={tea} accent={c.dot} />
          {(tea.origin || tea.harvestYear) && (
            <Section title="Provenance">
              <div style={S.provRow}>
                {tea.origin && <span style={S.provItem}><MapPin size={14} color={c.dot} /> {tea.origin}</span>}
                {tea.harvestYear && <span style={S.provItem}><Calendar size={14} color={c.dot} /> Harvest {tea.harvestYear}</span>}
              </div>
            </Section>
          )}
          {tea.reasoning && <Section title="Why this grade"><p style={{ ...S.sectionText, ...S.reasoning }}>{tea.reasoning}</p></Section>}
        </div>
        <div style={S.modalFoot}>
          {confirm ? (
            <><span style={S.confirmText}>Remove this tea?</span><button className="btn" onClick={() => setConfirm(false)}>Keep</button><button className="btn btn-danger" onClick={onDelete}><Trash2 size={15} /> Remove</button></>
          ) : (
            <><button className="btn btn-ghost-danger" onClick={() => setConfirm(true)}><Trash2 size={15} /> Remove</button><button className="btn btn-primary" onClick={onEdit}><Pencil size={15} /> Edit</button></>
          )}
        </div>
      </div>
    </Overlay>
  );
}

function Field({ label, children, full }) {
  return <label style={{ ...S.field, ...(full ? { gridColumn: "1 / -1" } : {}) }}><span style={S.fieldLabel}>{label}</span>{children}</label>;
}
function Section({ title, children }) {
  return <div style={S.section}><p style={S.sectionTitle}>{title}</p>{children}</div>;
}
function Overlay({ children, onClose }) {
  useEffect(() => {
    const onKey = (e) => { if (e.key === "Escape") onClose(); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);
  return <div style={S.overlay} onClick={onClose}>{children}</div>;
}

const SCAN_SYSTEM = "You read photos of Chinese tea packaging and return a single JSON object describing the tea. Translate any Chinese on the label. Infer tea type, brewing guidance, origin, harvest year, and an approximate rarity and grade using the label plus general knowledge of Chinese tea grading. Respond with ONLY valid JSON, no prose, no markdown fences. Keys: englishName, chineseName, type, flavourNotes, brewTemp, steepTime, origin, harvestYear, rarity, grade, reasoning. Rules: type must be one of Green, White, Yellow, Oolong, Black, Dark, Pu-erh, Scented, Herbal, Other. brewTemp is a number in Celsius as a string (e.g. \"85\"). steepTime is short text (e.g. \"2–3 min\" or \"15 sec\"). rarity is one of Common, Uncommon, Rare, Very rare. grade is one of Everyday, Standard, Premium, Competition, Imperial / Gong Ting, or empty. reasoning is one or two sentences explaining the rarity and grade call. Use empty string for anything you cannot determine.";

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

function extractJsonObject(text) {
  if (!text) return null;
  let clean = text.replace(/```json/gi, "").replace(/```/g, "").trim();
  try { return JSON.parse(clean); } catch (e) {}
  // Find the first balanced { ... } block, tolerating prose around it.
  const start = clean.indexOf("{");
  if (start === -1) return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < clean.length; i++) {
    const ch = clean[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === "\\") esc = true;
      else if (ch === '"') inStr = false;
    } else {
      if (ch === '"') inStr = true;
      else if (ch === "{") depth++;
      else if (ch === "}") { depth--; if (depth === 0) { const cand = clean.slice(start, i + 1); try { return JSON.parse(cand); } catch (e) { return null; } } }
    }
  }
  return null;
}

// The Anthropic call lives on the backend (/api/scan) so the API key never
// reaches the browser. This sends only the image bytes and the system prompt.
async function readLabelWithClaude(dataUrl) {
  const { mediaType, b64 } = parseDataUrl(dataUrl);
  const body = JSON.stringify({ mediaType, b64, system: SCAN_SYSTEM });

  let lastErr = null;
  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) await sleep(600 * attempt);
    let res;
    try {
      res = await fetch(`${API_BASE}/api/scan`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body,
      });
    } catch (e) { lastErr = new Error("Network hiccup while reading the label. Check your connection and try again."); continue; }

    // 503 is the backend saying scanning is unconfigured — deterministic, so it
    // is checked before the retryable 5xx branch that would otherwise swallow it.
    if (res.status === 503) throw new Error("Label scanning isn't configured on the server. Enter the details by hand.");
    if (res.status === 429 || res.status >= 500) { lastErr = new Error("The label reader is busy right now. Give it a moment and re-read."); continue; }
    if (!res.ok) throw new Error("The label reader is unavailable right now. Enter the details by hand.");

    let data;
    try { data = await res.json(); }
    catch (e) { lastErr = new Error("Got a garbled response. Try re-reading the photo."); continue; }

    const text = (data && typeof data.text === "string" ? data.text : "").trim();
    const parsed = extractJsonObject(text);
    if (!parsed || typeof parsed !== "object") { lastErr = new Error("Couldn't make sense of that label. Try a clearer, well-lit photo."); continue; }

    // Normalise fields defensively so a partial/odd response can't crash the form.
    const safe = (v) => (typeof v === "string" ? v : v == null ? "" : String(v));
    const out = {
      englishName: safe(parsed.englishName), chineseName: safe(parsed.chineseName),
      type: safe(parsed.type), flavourNotes: safe(parsed.flavourNotes),
      brewTemp: safe(parsed.brewTemp), steepTime: safe(parsed.steepTime),
      origin: safe(parsed.origin), harvestYear: safe(parsed.harvestYear),
      rarity: safe(parsed.rarity), grade: safe(parsed.grade), reasoning: safe(parsed.reasoning),
    };
    if (out.type && TEA_TYPES.indexOf(out.type) === -1) out.type = "Other";
    return out;
  }
  throw lastErr || new Error("Couldn't read that label. Fill the fields in by hand.");
}

function fileToDataUrl(file) {
  return new Promise((res, rej) => {
    if (!file) { rej(new Error("No file was selected.")); return; }
    const r = new FileReader();
    r.onload = () => {
      const out = r.result;
      if (typeof out !== "string" || out.indexOf("data:") !== 0 || out.indexOf(",") === -1) {
        rej(new Error("That file didn't read as an image. Try a different photo or format (JPEG or PNG)."));
        return;
      }
      res(out);
    };
    r.onerror = () => rej(new Error("Couldn't read that file. It may be corrupted — try another photo."));
    r.onabort = () => rej(new Error("Reading the file was interrupted. Try again."));
    try { r.readAsDataURL(file); }
    catch (e) { rej(new Error("Couldn't open that file. Try a JPEG or PNG.")); }
  });
}

// Re-encode any image to a clean, size-bounded JPEG data URL. This fixes HEIC,
// oversized photos, and odd colour profiles that the API can reject, and
// guarantees a well-formed "data:image/jpeg;base64,..." string downstream.
function normalizeImage(dataUrl, maxDim = 1600, quality = 0.85) {
  return new Promise((resolve) => {
    try {
      const img = new Image();
      img.onload = () => {
        try {
          let { width, height } = img;
          if (!width || !height) { resolve(dataUrl); return; }
          const scale = Math.min(1, maxDim / Math.max(width, height));
          const w = Math.max(1, Math.round(width * scale));
          const h = Math.max(1, Math.round(height * scale));
          const canvas = document.createElement("canvas");
          canvas.width = w; canvas.height = h;
          const ctx = canvas.getContext("2d");
          if (!ctx) { resolve(dataUrl); return; }
          ctx.drawImage(img, 0, 0, w, h);
          const out = canvas.toDataURL("image/jpeg", quality);
          resolve(out && out.indexOf("data:image/jpeg") === 0 ? out : dataUrl);
        } catch (e) { resolve(dataUrl); }
      };
      img.onerror = () => resolve(dataUrl); // fall back to original if it won't decode
      img.src = dataUrl;
    } catch (e) { resolve(dataUrl); }
  });
}

// Robustly split a data URL into { mediaType, b64 }, validating structure.
function parseDataUrl(dataUrl) {
  if (typeof dataUrl !== "string") throw new Error("No image to read.");
  const comma = dataUrl.indexOf(",");
  if (dataUrl.indexOf("data:") !== 0 || comma === -1) throw new Error("The photo data looks malformed. Re-upload the image.");
  const meta = dataUrl.slice(5, comma);
  const b64 = dataUrl.slice(comma + 1);
  if (!b64 || b64.length < 16) throw new Error("The photo appears empty. Try a clearer shot.");
  const mediaType = (meta.split(";")[0] || "").trim() || "image/jpeg";
  const allowed = ["image/jpeg", "image/png", "image/gif", "image/webp"];
  return { mediaType: allowed.indexOf(mediaType) === -1 ? "image/jpeg" : mediaType, b64 };
}
function firstHanzi(s) { if (!s) return ""; const m = s.match(/[\u4e00-\u9fff]/g); return m ? m.slice(0, 2).join("") : ""; }
function shorten(s, n) { return s && s.length > n ? s.slice(0, n - 1) + "…" : s; }
function rarityStyle(r) {
  const map = { Common: { background: "#EDEBE4", color: "#5F5A4C" }, Uncommon: { background: "#E3EDDD", color: "#3F5A28" }, Rare: { background: "#EDE1CF", color: "#7A5320" }, "Very rare": { background: "#F0E0E7", color: "#7C3457" } };
  return map[r] || map.Common;
}

// Typical caffeine per standard serving, for context (approximate, mg).
const CAFFEINE_REFERENCE = [
  { label: "Herbal infusion", mg: 0, note: "caffeine-free" },
  { label: "Decaf coffee", mg: 3, note: "8 oz" },
  { label: "Green tea", mg: 28, note: "8 oz cup" },
  { label: "Black tea", mg: 47, note: "8 oz cup" },
  { label: "Cola", mg: 34, note: "12 oz can" },
  { label: "Energy drink", mg: 80, note: "8 oz" },
  { label: "Espresso", mg: 63, note: "1 shot" },
  { label: "Brewed coffee", mg: 95, note: "8 oz cup" },
];

// Pull an approximate mg number from a free-text caffeine field.
// "~30 mg" -> 30, "30–45 mg" -> 37 (midpoint), "Caffeine-free" -> 0, else null.
function parseCaffeineMg(s) {
  if (typeof s !== "string" || !s.trim()) return null;
  if (/free|none|no caffeine/i.test(s)) return 0;
  const nums = (s.match(/\d+(?:\.\d+)?/g) || []).map(Number);
  if (nums.length === 0) return null;
  if (nums.length === 1) return nums[0];
  return Math.round((nums[0] + nums[nums.length - 1]) / 2);
}

function CaffeineContext({ tea, accent }) {
  const teaMg = parseCaffeineMg(tea.caffeine);
  if (teaMg === null) return null; // nothing numeric to compare
  const teaRow = { label: `This tea (${tea.englishName ? shorten(tea.englishName, 18) : "selected"})`, mg: teaMg, note: tea.caffeine, isTea: true };
  const rows = [...CAFFEINE_REFERENCE, teaRow].sort((a, b) => a.mg - b.mg);
  const max = Math.max(95, teaMg, ...CAFFEINE_REFERENCE.map((r) => r.mg));
  return (
    <Section title="Caffeine in context">
      <p style={S.ctxIntro}>How a gaiwan cup of this tea compares with common drinks (approximate, per typical serving).</p>
      <div style={S.ctxChart}>
        {rows.map((r) => {
          const pct = max > 0 ? Math.max(r.mg > 0 ? 4 : 0, (r.mg / max) * 100) : 0;
          return (
            <div key={r.label} style={S.ctxRow}>
              <span style={{ ...S.ctxLabel, ...(r.isTea ? { fontWeight: 700, color: INK } : {}) }}>{r.label}</span>
              <div style={S.ctxTrack}>
                <div style={{ ...S.ctxBar, width: `${pct}%`, background: r.isTea ? accent : "#DAD3C2" }} />
              </div>
              <span style={{ ...S.ctxVal, ...(r.isTea ? { fontWeight: 700, color: INK } : {}) }}>{r.mg === 0 ? "0" : r.mg} mg</span>
            </div>
          );
        })}
      </div>
      <p style={S.ctxFoot}>Figures are rough averages; actual caffeine varies with leaf amount, water temperature, steep time, and which infusion you drink.</p>
    </Section>
  );
}


const INK = "#2E2A22"; const PAPER = "#FBF9F3"; const CLAY = "#8A5A3C";
const S = {
  root: { fontFamily: "'Inter', system-ui, sans-serif", background: PAPER, color: INK, minHeight: "100vh", padding: "28px clamp(16px, 4vw, 44px) 64px", maxWidth: 1180, margin: "0 auto" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "flex-end", gap: 16, flexWrap: "wrap", paddingBottom: 22, borderBottom: "1px solid #E7E1D3" },
  brandRow: { display: "flex", alignItems: "center", gap: 16 },
  mark: { width: 54, height: 54, borderRadius: 14, background: INK, display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  markHanzi: { fontFamily: "'Noto Serif SC', serif", color: PAPER, fontSize: 30, lineHeight: 1, marginTop: 2 },
  h1: { fontFamily: "'Noto Serif SC', 'Inter', serif", fontSize: "clamp(24px, 4vw, 32px)", fontWeight: 600, margin: 0, letterSpacing: "-0.01em" },
  sub: { margin: "3px 0 0", fontSize: 14, color: "#8C8574" },
  controls: { display: "flex", gap: 14, alignItems: "center", flexWrap: "wrap", margin: "22px 0 26px" },
  searchWrap: { display: "flex", alignItems: "center", gap: 9, background: "#fff", border: "1px solid #E4DECF", borderRadius: 11, padding: "0 12px", height: 42, flex: "1 1 260px", minWidth: 220 },
  search: { border: "none", outline: "none", background: "transparent", fontSize: 14.5, flex: 1, color: INK, fontFamily: "inherit" },
  chips: { display: "flex", gap: 7, flexWrap: "wrap" },
  chip: { display: "inline-flex", alignItems: "center", gap: 6, height: 34, padding: "0 12px", borderRadius: 9, border: "1px solid #E4DECF", background: "#fff", color: "#736C5C", fontSize: 13.5, fontWeight: 500, cursor: "pointer", fontFamily: "inherit", transition: "all .15s" },
  chipActive: { background: INK, color: PAPER, borderColor: INK },
  chipDot: { width: 8, height: 8, borderRadius: "50%", flexShrink: 0 },
  chipCount: { fontSize: 11.5, opacity: 0.6, fontVariantNumeric: "tabular-nums" },
  grid: { display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(224px, 1fr))", gap: 18 },
  card: { textAlign: "left", padding: 0, border: "1px solid #E7E1D3", borderRadius: 16, background: "#fff", cursor: "pointer", overflow: "hidden", fontFamily: "inherit", color: "inherit", transition: "transform .16s, box-shadow .16s, border-color .16s", display: "flex", flexDirection: "column" },
  cardTop: { position: "relative", height: 128, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  cardImg: { width: "100%", height: "100%", objectFit: "cover" },
  cardHanzi: { fontFamily: "'Noto Serif SC', serif", fontSize: 44, lineHeight: 1, opacity: 0.9 },
  typeTag: { position: "absolute", top: 10, left: 10, color: "#fff", fontSize: 11.5, fontWeight: 600, padding: "3px 9px", borderRadius: 7, letterSpacing: "0.01em" },
  rarityTag: { position: "absolute", top: 10, right: 10, background: "rgba(255,255,255,0.82)", color: "#5b5344", fontSize: 10.5, fontWeight: 600, padding: "3px 8px", borderRadius: 7, textTransform: "uppercase", letterSpacing: "0.04em" },
  gradeTag: { position: "absolute", top: 10, right: 10, maxWidth: "60%", background: "rgba(255,255,255,0.86)", color: "#5b5344", fontSize: 10.5, fontWeight: 600, padding: "3px 8px", borderRadius: 7, textTransform: "uppercase", letterSpacing: "0.04em", textAlign: "right", lineHeight: 1.3 },
  cardBody: { padding: "13px 15px 15px", display: "flex", flexDirection: "column", gap: 8, flex: 1 },
  cardNames: { display: "flex", flexDirection: "column", gap: 2 },
  cardEn: { fontSize: 16, fontWeight: 600, lineHeight: 1.25, letterSpacing: "-0.01em" },
  cardZh: { fontFamily: "'Noto Serif SC', serif", fontSize: 13.5, color: "#9A9282" },
  cardFlavour: { margin: 0, fontSize: 13, lineHeight: 1.5, color: "#7C7565", display: "-webkit-box", WebkitLineClamp: 2, WebkitBoxOrient: "vertical", overflow: "hidden" },
  cardMeta: { display: "flex", flexWrap: "wrap", gap: "5px 12px", marginTop: "auto", paddingTop: 4 },
  metaItem: { display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "#9A9282" },
  empty: { display: "flex", flexDirection: "column", alignItems: "center", justifyContent: "center", textAlign: "center", padding: "72px 20px", color: "#9A9282" },
  emptyMark: { fontFamily: "'Noto Serif SC', serif", fontSize: 60, color: "#DDD5C4", marginBottom: 8 },
  emptyTitle: { fontSize: 18, fontWeight: 600, color: INK, margin: "0 0 4px" },
  emptySub: { fontSize: 14, margin: "0 0 14px", maxWidth: 320, lineHeight: 1.5 },
  overlay: { position: "fixed", inset: 0, background: "rgba(40,36,28,0.42)", display: "flex", alignItems: "flex-start", justifyContent: "center", padding: "5vh 16px 16px", zIndex: 50, overflowY: "auto" },
  modal: { background: PAPER, borderRadius: 20, width: "100%", maxWidth: 560, boxShadow: "0 24px 60px rgba(40,30,15,0.28)", display: "flex", flexDirection: "column", maxHeight: "90vh", overflow: "hidden" },
  modalHead: { display: "flex", alignItems: "center", justifyContent: "space-between", padding: "18px 20px 14px", borderBottom: "1px solid #EAE4D6" },
  modalTitle: { fontFamily: "'Noto Serif SC', serif", fontSize: 20, fontWeight: 600, margin: 0 },
  modalScroll: { overflowY: "auto", padding: "18px 20px", flex: 1 },
  modalFoot: { display: "flex", justifyContent: "flex-end", alignItems: "center", gap: 10, padding: "14px 20px", borderTop: "1px solid #EAE4D6", background: "#fff" },
  intake: { display: "flex", gap: 14, alignItems: "flex-start", padding: 15, borderRadius: 14, marginBottom: 14 },
  intakeIcon: { width: 58, height: 58, borderRadius: 12, background: "rgba(255,255,255,0.6)", display: "flex", alignItems: "center", justifyContent: "center", flexShrink: 0 },
  intakeImg: { width: 58, height: 58, borderRadius: 12, objectFit: "cover", flexShrink: 0 },
  intakeTitle: { fontSize: 15, fontWeight: 600, margin: 0, color: INK },
  intakeSub: { fontSize: 12.5, margin: "3px 0 10px", lineHeight: 1.45, color: "#6f6a5b" },
  intakeBtns: { display: "flex", gap: 8, flexWrap: "wrap" },
  scanState: { display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#6f6a5b", padding: "9px 12px", background: "#fff", border: "1px solid #EAE4D6", borderRadius: 10, marginBottom: 14 },
  scanOk: { background: "#EAF2E2", border: "1px solid #CBE0B8", color: "#3F5A28" },
  scanErr: { background: "#FBEBE8", border: "1px solid #F1CDC4", color: "#8A4132" },
  fieldGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: 14 },
  field: { display: "flex", flexDirection: "column", gap: 6 },
  fieldLabel: { fontSize: 12, fontWeight: 600, color: "#847D6C", letterSpacing: "0.01em" },
  section: { marginBottom: 18 },
  sectionTitle: { fontSize: 11.5, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.07em", color: "#A59D8A", margin: "0 0 7px" },
  sectionText: { margin: 0, fontSize: 14.5, lineHeight: 1.55, color: "#453f33" },
  reasoning: { fontStyle: "italic", color: "#6f6a5b", background: "#fff", border: "1px solid #EAE4D6", borderLeft: `3px solid ${CLAY}`, borderRadius: 8, padding: "11px 13px" },
  detailHero: { position: "relative", height: 168, display: "flex", alignItems: "center", justifyContent: "center", overflow: "hidden" },
  detailImg: { width: "100%", height: "100%", objectFit: "cover" },
  detailHanzi: { fontFamily: "'Noto Serif SC', serif", fontSize: 72, lineHeight: 1, opacity: 0.92 },
  detailClose: { position: "absolute", top: 12, right: 12, background: "rgba(255,255,255,0.85)", zIndex: 2 },
  detailNames: { display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12, marginBottom: 14 },
  detailEn: { fontFamily: "'Noto Serif SC', serif", fontSize: 24, fontWeight: 600, margin: 0, letterSpacing: "-0.01em" },
  detailZh: { fontFamily: "'Noto Serif SC', serif", fontSize: 16, color: "#9A9282", margin: "3px 0 0" },
  badges: { display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 18 },
  gradeBadge: { display: "inline-flex", alignItems: "center", gap: 5, fontSize: 12.5, fontWeight: 600, padding: "5px 11px", borderRadius: 8, background: "#F3ECD9", color: "#7A5A1C" },
  rarityBadge: { display: "inline-flex", alignItems: "center", fontSize: 12.5, fontWeight: 600, padding: "5px 11px", borderRadius: 8 },
  typeTagLg: { color: "#fff", fontSize: 12.5, fontWeight: 600, padding: "4px 11px", borderRadius: 8, whiteSpace: "nowrap", flexShrink: 0 },
  brewRow: { display: "flex", gap: 12 },
  brewCell: { flex: 1, display: "flex", flexDirection: "column", alignItems: "center", gap: 3, padding: "13px 10px", background: "#fff", border: "1px solid #EAE4D6", borderRadius: 11 },
  brewVal: { fontSize: 17, fontWeight: 600, color: INK },
  brewLbl: { fontSize: 11.5, color: "#A59D8A", textTransform: "uppercase", letterSpacing: "0.05em" },
  ctxIntro: { margin: "0 0 12px", fontSize: 13, lineHeight: 1.5, color: "#7C7565" },
  ctxChart: { display: "flex", flexDirection: "column", gap: 8 },
  ctxRow: { display: "grid", gridTemplateColumns: "minmax(96px, 34%) 1fr auto", alignItems: "center", gap: 10 },
  ctxLabel: { fontSize: 12.5, color: "#6f6a5b", lineHeight: 1.25 },
  ctxTrack: { position: "relative", height: 12, background: "#F0ECE1", borderRadius: 6, overflow: "hidden" },
  ctxBar: { position: "absolute", left: 0, top: 0, height: "100%", borderRadius: 6, transition: "width .4s ease", minWidth: 2 },
  ctxVal: { fontSize: 12, color: "#847D6C", fontVariantNumeric: "tabular-nums", whiteSpace: "nowrap", textAlign: "right" },
  ctxFoot: { margin: "12px 0 0", fontSize: 11.5, lineHeight: 1.5, color: "#A59D8A", fontStyle: "italic" },
  provRow: { display: "flex", flexDirection: "column", gap: 8 },
  provItem: { display: "inline-flex", alignItems: "center", gap: 7, fontSize: 14, color: "#453f33" },
  confirmText: { fontSize: 13.5, color: "#8A4132", marginRight: "auto", fontWeight: 500 },
  toast: { position: "fixed", bottom: 22, left: "50%", transform: "translateX(-50%)", background: INK, color: PAPER, fontSize: 14, fontWeight: 500, padding: "11px 18px", borderRadius: 11, display: "flex", alignItems: "center", gap: 9, boxShadow: "0 10px 30px rgba(40,30,15,0.3)", zIndex: 60 },
  toastErr: { background: "#8A4132" },
};

const CSS = `
@import url('https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=Noto+Serif+SC:wght@500;600;700&display=swap');
* { box-sizing: border-box; }
.spin { animation: spin 0.8s linear infinite; }
@keyframes spin { to { transform: rotate(360deg); } }
.tea-card:hover { transform: translateY(-3px); box-shadow: 0 12px 28px rgba(60,45,20,0.12); border-color: #D8CFB9 !important; }
.tea-card:focus-visible { outline: 2px solid ${CLAY}; outline-offset: 2px; }
.btn { display: inline-flex; align-items: center; gap: 7px; height: 40px; padding: 0 16px; border-radius: 10px; border: 1px solid #DDD5C2; background: #fff; color: ${INK}; font-size: 14px; font-weight: 500; cursor: pointer; font-family: inherit; transition: all .15s; white-space: nowrap; }
.btn:hover { background: #F5F1E7; border-color: #CFC6B0; }
.btn:active { transform: scale(0.98); }
.btn-small { height: 32px; padding: 0 12px; font-size: 13px; border-radius: 8px; }
.btn-primary { background: ${INK}; color: ${PAPER}; border-color: ${INK}; }
.btn-primary:hover { background: #423C30; border-color: #423C30; }
.btn-danger { background: #A5432E; color: #fff; border-color: #A5432E; }
.btn-danger:hover { background: #8E3725; }
.btn-ghost-danger { color: #A5432E; border-color: #E6CFC7; margin-right: auto; }
.btn-ghost-danger:hover { background: #FBEBE8; }
.icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 34px; height: 34px; border-radius: 9px; border: none; background: transparent; color: #7C7565; cursor: pointer; transition: background .15s; }
.icon-btn:hover { background: rgba(0,0,0,0.06); }
.clear-x { border: none; background: transparent; color: #A59D8A; cursor: pointer; display: flex; padding: 2px; border-radius: 6px; }
.clear-x:hover { background: #F0ECE1; }
.chip:hover { border-color: #CFC6B0; }
.tea-search::placeholder { color: #A59D8A; }
.fld { width: 100%; border: 1px solid #E0D9C8; border-radius: 9px; padding: 9px 11px; font-size: 14px; font-family: inherit; color: ${INK}; background: #fff; outline: none; transition: border-color .15s, box-shadow .15s; }
.fld:focus { border-color: ${CLAY}; box-shadow: 0 0 0 3px rgba(138,90,60,0.12); }
textarea.fld { resize: vertical; line-height: 1.5; }
select.fld { cursor: pointer; }
`;
