import { useState, useEffect, useCallback, useRef } from "react";

const uid = () => Math.random().toString(36).slice(2, 10);


const emptyTournament = () => ({
  id: uid(),
  name: "KyleVision",
  status: "setup", // setup | running | done
  contestNumber: 1,
  requiredSongs: 3, // kept for backwards compatibility; min/max below control submissions
  minSongs: 3,
  maxSongs: 3,
  entrants: [], // {id, name, songs: [song1, song2, ...], songsUsed: 0}
  winners: [], // rounds: [ [match,...], [match,...] ]
  losers: [],
  grandFinal: null, // match
  votingOpen: false,
  votes: { a: 0, b: 0 },
  activeMatchPath: null, // {bracket:'awinners'|'losers'|'final', round, index}
});

// The song an entrant plays for a given match is songs[songsUsed], taken at
// the moment they enter that match. songsUsed increments only when they WIN
// and move on to the next match, so each round consumes the next song in
// the order they submitted them.
function currentSongFor(entrant) {
  if (!entrant || !Array.isArray(entrant.songs) || entrant.songs.length === 0) {
    return "(no song)";
  }
  const idx = (Number(entrant.songsUsed || 0)) % entrant.songs.length;
  return entrant.songs[idx] || entrant.songs[0] || "(no song)";
}
function hasSongLeft(entrant) {
  if (!entrant) return true;
  return (entrant.songsUsed || 0) < entrant.songs.length;
}

function makeMatch(a, b) {
  return { id: uid(), a: a || null, b: b || null, winner: null };
}

// Build a standard single-elim winners bracket + losers bracket skeleton for n entrants
function buildBracket(entrants) {
  const n = entrants.length;
  const size = Math.pow(2, Math.ceil(Math.log2(Math.max(2, n))));
  const slots = [...entrants];
  while (slots.length < size) slots.push(null); // byes

  // seed shuffle-ish: keep order simple (mod list) - could randomize
  const round1 = [];
  for (let i = 0; i < size / 2; i++) {
    round1.push(makeMatch(slots[i * 2], slots[i * 2 + 1]));
  }
  const winners = [round1];
  let count = round1.length;
  while (count > 1) {
    count = count / 2;
    winners.push(Array.from({ length: count }, () => makeMatch(null, null)));
  }
  // losers bracket sized for double elim of this bracket size (simplified linear consolidation)
  const losers = [];
  let lcount = size / 4 >= 1 ? size / 2 : 0;
  // We'll build losers bracket rounds dynamically as we go rather than pre-fill fully,
  // since exact double-elim shape depends on byes. Start with empty first round matches
  // sized to accept round1 losers.
  let firstLosersCount = Math.floor(round1.length / 2);
  if (firstLosersCount > 0) {
    losers.push(Array.from({ length: firstLosersCount }, () => makeMatch(null, null)));
  }
  return { winners, losers, grandFinal: null };
}

function autoResolveByes(t) {
  // if a match has exactly one real entrant and one null, auto-advance
  const advance = (bracket) => {
    for (let r = 0; r < bracket.length; r++) {
      for (const m of bracket[r]) {
        if (!m.winner && m.a && !m.b) m.winner = m.a;
        if (!m.winner && !m.a && m.b) m.winner = m.b;
      }
    }
  };
  advance(t.winners);
  propagate(t);
  return t;
}

function propagate(t) {
  const fresh = (entrant) => {
    if (!entrant) return entrant;
    const found = t.entrants.find((e) => e.id === entrant.id);
    return found || entrant;
  };
  // push winners bracket winners forward into next round
  for (let r = 0; r < t.winners.length - 1; r++) {
    const cur = t.winners[r];
    const next = t.winners[r + 1];
    for (let i = 0; i < cur.length; i++) {
      const m = cur[i];
      const slot = next[Math.floor(i / 2)];
      if (m.winner) {
        if (i % 2 === 0) slot.a = fresh(m.winner);
        else slot.b = fresh(m.winner);
      }
    }
  }
  // losers dropping into losers bracket round 0 from winners round 0
  if (t.winners[0] && t.losers[0]) {
    const r0 = t.winners[0];
    const lr0 = t.losers[0];
    for (let i = 0; i < r0.length; i++) {
      const m = r0[i];
      if (!m.winner) continue;
      const loser = m.a && m.winner.id === m.a.id ? m.b : m.a;
      if (!loser) continue;
      const slot = lr0[Math.floor(i / 2)];
      if (i % 2 === 0) slot.a = fresh(loser);
      else slot.b = fresh(loser);
    }
  }
  // propagate losers bracket forward + feed subsequent winners-round losers in
  const losersRoundsAtStart = t.losers.length;
  for (let r = 0; r < losersRoundsAtStart; r++) {
    const cur = t.losers[r];
    let next = t.losers[r + 1];
    if (!next && r === losersRoundsAtStart - 1) {
      next = Array.from({ length: Math.max(1, Math.ceil(cur.length / 2)) }, () => makeMatch(null, null));
      t.losers.push(next);
    } else if (!next) {
      continue;
    }
    for (let i = 0; i < cur.length; i++) {
      const m = cur[i];
      if (!m.winner) continue;
      const slot = next[Math.floor(i / 2)];
      if (!slot.a) slot.a = fresh(m.winner);
      else if (!slot.b && slot.a.id !== m.winner.id) slot.b = fresh(m.winner);
    }
  }
  // feed winners-round(r>=1) losers into losers bracket at corresponding depth
  for (let r = 1; r < t.winners.length; r++) {
    const wr = t.winners[r];
    const targetRoundIdx = r * 2 - 1; // heuristic slot for merge round
    let target = t.losers[targetRoundIdx];
    if (!target) {
      target = Array.from({ length: Math.max(1, wr.length) }, () => makeMatch(null, null));
      t.losers[targetRoundIdx] = target;
    }
    for (let i = 0; i < wr.length; i++) {
      const m = wr[i];
      if (!m.winner) continue;
      const loser = m.a && m.winner.id === m.a.id ? m.b : m.a;
      if (!loser) continue;
      const slot = target[Math.min(i, target.length - 1)];
      if (!slot.a) slot.a = fresh(loser);
      else if (!slot.b) slot.b = fresh(loser);
    }
  }
  // set up grand final once both finals resolved
  const wFinal = t.winners[t.winners.length - 1]?.[0];
  const lFinalRound = t.losers[t.losers.length - 1];
  const lFinal = lFinalRound ? lFinalRound[lFinalRound.length - 1] : null;
  if (wFinal?.winner && lFinal?.winner && !t.grandFinal) {
    t.grandFinal = makeMatch(fresh(wFinal.winner), fresh(lFinal.winner));
  } else if (t.grandFinal) {
    if (wFinal?.winner) t.grandFinal.a = wFinal.winner;
    if (lFinal?.winner) t.grandFinal.b = lFinal.winner;
  }
}

const SUPABASE_URL = "https://ryulmfihszlcawlvgrzu.supabase.co";
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6InJ5dWxtZmloc3psY2F3bHZncnp1Iiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODgwOTI1MTEsImV4cCI6MjEwMzY2ODUxMX0.mcXyW9z9REV5zxZfaLdXXXbe0rMbcdnYVHNIMVi2mqE";

async function sb(path, options = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...options,
    headers: {
      apikey: SUPABASE_ANON_KEY,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      "Content-Type": "application/json",
      Prefer: options.prefer || "return=representation",
      ...(options.headers || {}),
    },
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Supabase error ${res.status}: ${text}`);
  }
  const text = await res.text();
  return text ? JSON.parse(text) : null;
}

async function loadState() {
  const rows = await sb("tournament_state?id=eq.main&select=data");
  const raw = rows?.[0]?.data || emptyTournament();

  return {
    ...emptyTournament(),
    ...raw,
    contestNumber: Number(raw.contestNumber || 1),
    requiredSongs: Math.max(1, Number(raw.requiredSongs || raw.minSongs || 3)),
    minSongs: Math.max(1, Number(raw.minSongs || raw.requiredSongs || 3)),
    maxSongs: Math.max(
      Math.max(1, Number(raw.minSongs || raw.requiredSongs || 3)),
      Number(raw.maxSongs || raw.requiredSongs || 3)
    ),
  };
}

async function saveState(t) {
  const result = await sb("tournament_state?id=eq.main", {
    method: "PATCH",
    body: JSON.stringify({ data: t }),
  });
  return result;
}
async function loadSubs() {
  try {
    const rows = await sb("submissions?select=id,name,songs&order=created_at.asc");
    return rows || [];
  } catch (e) {
    console.error("load failed", e);
    return [];
  }
}
async function saveSubs(subs) {
  // subs list is derived from the table; this function now just deletes
  // rows that are no longer present (used after approve/reject).
  // Kept for API compatibility with the rest of the app.
  return subs;
}
async function addSubmission(name, songs) {
  await sb("submissions", {
    method: "POST",
    body: JSON.stringify([{ id: uid(), name, songs }]),
  });
}
async function deleteSubmission(id) {
  await sb(`submissions?id=eq.${id}`, { method: "DELETE" });
}

const ADMIN_SESSION_KEY = "kv-admin-unlocked";

async function getAdminPasswordHash() {
  try {
    const rows = await sb("admin_config?id=eq.main&select=password_hash");
    return rows && rows.length > 0 ? rows[0].password_hash : null;
  } catch {
    return null;
  }
}
async function setAdminPassword(hash) {
  const existing = await sb("admin_config?id=eq.main&select=id");
  if (existing && existing.length > 0) {
    await sb("admin_config?id=eq.main", { method: "PATCH", body: JSON.stringify({ password_hash: hash }) });
  } else {
    await sb("admin_config", { method: "POST", body: JSON.stringify([{ id: "main", password_hash: hash }]) });
  }
}
async function simpleHash(text) {
  const enc = new TextEncoder().encode(text);
  const buf = await crypto.subtle.digest("SHA-256", enc);
  return Array.from(new Uint8Array(buf)).map((b) => b.toString(16).padStart(2, "0")).join("");
}

function advanceEntrantSong(t, entrantId) {
  if (!t || !entrantId || !Array.isArray(t.entrants)) return;
  const entrant = t.entrants.find((e) => e.id === entrantId);
  if (!entrant || !Array.isArray(entrant.songs) || entrant.songs.length === 0) return;

  const used = Number(entrant.songsUsed || 0);
  entrant.songsUsed = Math.min(used + 1, entrant.songs.length);
}

function nameFor(entrant, anonymous, label) {
  if (!entrant) return null;
  if (anonymous) return label;
  const song = currentSongFor(entrant);
  const songNum = (entrant.songsUsed || 0) + 1;
  return `${entrant.name} — ${song} (song ${songNum}/${entrant.songs.length})`;
}

function MatchCard({ m, label, anonymous, onPick, editable }) {
  const isDone = !!m.winner;
  const pick = (side) => {
    if (!editable || m.winner || !m.a || !m.b) return;
    const chosen = side === "a" ? m.a : m.b;
    if (!chosen) return;
    onPick(chosen);
  };
  const row = (side, entrant) => {
    const won = isDone && entrant && m.winner.id === entrant.id;
    const lost = isDone && entrant && m.winner.id !== entrant.id;
    const outOfSongs = false; // Songs automatically replay in submission order when exhausted.
    return (
      <div
        onClick={() => pick(side)}
        style={{
          display: "flex",
          justifyContent: "space-between",
          alignItems: "center",
          padding: "8px 10px",
          borderRadius: 6,
          background: won ? "var(--bg-success)" : "var(--surface-1)",
          border: "0.5px solid " + (won ? "var(--border-success)" : "var(--border)"),
          opacity: lost ? 0.5 : 1,
          cursor: editable && entrant ? "pointer" : "default",
          marginBottom: 4,
        }}
      >
        <span style={{ fontSize: 13, fontWeight: won ? 500 : 400 }}>
          {entrant ? nameFor(entrant, anonymous, side === "a" ? `${label} · 1` : `${label} · 2`) : "TBD"}
        </span>
        <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {outOfSongs && (
            <span style={{ fontSize: 11, color: "var(--text-warning)", background: "var(--bg-warning)", padding: "2px 6px", borderRadius: 4 }}>
              out of songs
            </span>
          )}
          {won && <i className="ti ti-check" style={{ fontSize: 14, color: "var(--text-success)" }} aria-hidden="true" />}
        </span>
      </div>
    );
  };
  return (
    <div style={{ background: "var(--surface-2)", border: "0.5px solid var(--border)", borderRadius: 10, padding: 8, minWidth: 180 }}>
      <div style={{ fontSize: 11, color: "var(--text-muted)", marginBottom: 6 }}>{label}</div>
      {row("a", m.a)}
      {row("b", m.b)}
    </div>
  );
}

function BracketColumn({ title, rounds, anonymous, onPick, editable, labelPrefix }) {
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
      <h3 style={{ margin: "0 0 8px" }}>{title}</h3>
      <div style={{ display: "flex", gap: 24, overflowX: "auto", paddingBottom: 8 }}>
        {rounds.map((round, ri) => (
          <div key={ri} style={{ display: "flex", flexDirection: "column", gap: 20, justifyContent: "center" }}>
            <div style={{ fontSize: 12, color: "var(--text-secondary)", textAlign: "center" }}>
              {labelPrefix} round {ri + 1}
            </div>
            {round.map((m, mi) => (
              <MatchCard
                key={m.id}
                m={m}
                label={`R${ri + 1} M${mi + 1}`}
                anonymous={anonymous}
                editable={editable}
                onPick={(winner) => onPick(title.toLowerCase().includes("loser") ? "losers" : "winners", ri, mi, winner)}
              />
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}

function AdminLock({ onUnlock }) {
  const [existingHash, setExistingHash] = useState(undefined); // undefined = loading, null = no password set yet
  const [pw, setPw] = useState("");
  const [pw2, setPw2] = useState("");
  const [err, setErr] = useState("");

  useEffect(() => {
    (async () => {
      setExistingHash(await getAdminPasswordHash());
    })();
  }, []);

  const submitFirstTime = async () => {
    if (pw.length < 4) {
      setErr("Password should be at least 4 characters");
      return;
    }
    if (pw !== pw2) {
      setErr("Passwords don't match");
      return;
    }
    const hash = await simpleHash(pw);
    try {
      await setAdminPassword(hash);
      localStorage.setItem(ADMIN_SESSION_KEY, hash);
      onUnlock();
    } catch (e) {
      console.error("Failed to save admin password:", e);
      setErr("Couldn't save the password. Check the database connection and try again.");
    }
  };

  const submitLogin = async () => {
    const hash = await simpleHash(pw);
    if (hash !== existingHash) {
      setErr("Wrong password");
      return;
    }
    localStorage.setItem(ADMIN_SESSION_KEY, hash);
    onUnlock();
  };

  if (existingHash === undefined) {
    return <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>;
  }

  if (existingHash === null) {
    return (
      <div style={{ maxWidth: 360, margin: "3rem auto", textAlign: "center" }}>
        <i className="ti ti-lock" style={{ fontSize: 28, color: "var(--text-muted)" }} aria-hidden="true" />
        <h2>Set an admin password</h2>
        <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>No password is set yet. Choose one now — you'll need it (and share it only with co-mods) to get back in.</p>
        <input type="password" placeholder="New password" value={pw} onChange={(e) => setPw(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
        <input type="password" placeholder="Confirm password" value={pw2} onChange={(e) => setPw2(e.target.value)} style={{ width: "100%", marginBottom: 8 }} />
        {err && <p style={{ color: "var(--text-danger)", fontSize: 13 }}>{err}</p>}
        <button onClick={submitFirstTime} style={{ width: "100%", borderColor: "var(--border-accent)", color: "var(--text-accent)" }}>Set password & continue</button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 320, margin: "3rem auto", textAlign: "center" }}>
      <i className="ti ti-lock" style={{ fontSize: 28, color: "var(--text-muted)" }} aria-hidden="true" />
      <h2>Admin login</h2>
      <input type="password" placeholder="Password" value={pw} onChange={(e) => setPw(e.target.value)} onKeyDown={(e) => e.key === "Enter" && submitLogin()} style={{ width: "100%", marginBottom: 8 }} />
      {err && <p style={{ color: "var(--text-danger)", fontSize: 13 }}>{err}</p>}
      <button onClick={submitLogin} style={{ width: "100%", borderColor: "var(--border-accent)", color: "var(--text-accent)" }}>Unlock</button>
    </div>
  );
}


function AdminContestSettings({ t, onSave }) {
  const [contestNumber, setContestNumber] = useState(Number(t?.contestNumber || 1));
  const [minSongs, setMinSongs] = useState(
    Math.max(1, Number(t?.minSongs || t?.requiredSongs || 3))
  );
  const [maxSongs, setMaxSongs] = useState(
    Math.max(
      Math.max(1, Number(t?.minSongs || t?.requiredSongs || 3)),
      Number(t?.maxSongs || t?.requiredSongs || 3)
    )
  );
  const [saved, setSaved] = useState(false);
  const [settingsErr, setSettingsErr] = useState("");

  useEffect(() => {
    const min = Math.max(1, Number(t?.minSongs || t?.requiredSongs || 3));
    const max = Math.max(min, Number(t?.maxSongs || t?.requiredSongs || 3));

    setContestNumber(Number(t?.contestNumber || 1));
    setMinSongs(min);
    setMaxSongs(max);
  }, [t?.contestNumber, t?.minSongs, t?.maxSongs, t?.requiredSongs]);

  const save = async () => {
    const cleanMin = Math.max(1, Math.floor(Number(minSongs) || 1));
    const cleanMax = Math.max(cleanMin, Math.floor(Number(maxSongs) || cleanMin));

    setSettingsErr("");

    const next = structuredClone(t);
    next.contestNumber = Math.max(1, Math.floor(Number(contestNumber) || 1));
    next.minSongs = cleanMin;
    next.maxSongs = cleanMax;
    // Keep the old field in sync for compatibility with older saved state.
    next.requiredSongs = cleanMin;

    try {
      await onSave(next);
      setMinSongs(cleanMin);
      setMaxSongs(cleanMax);
      setSaved(true);
      setTimeout(() => setSaved(false), 1800);
    } catch (e) {
      console.error("Contest settings save failed:", e);
      setSettingsErr("Couldn't save the contest settings.");
    }
  };

  return (
    <div
      style={{
        margin: "16px 0 24px",
        padding: 18,
        background: "var(--stage-card)",
        border: "1px solid var(--border)",
        borderRadius: "var(--radius)",
      }}
    >
      <h2 style={{ marginTop: 0 }}>Contest settings</h2>
      <p style={{ color: "var(--text-secondary)", fontSize: 13, marginTop: 4 }}>
        Changes are saved to Supabase and the public submission page checks for updates every 2 seconds.
      </p>

      <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
        <label style={{ fontSize: 13, fontWeight: 600 }}>
          Contest number
          <input
            type="number"
            min="1"
            value={contestNumber}
            onChange={(e) => setContestNumber(e.target.value)}
            style={{ width: "100%", marginTop: 6 }}
          />
        </label>

        <label style={{ fontSize: 13, fontWeight: 600 }}>
          Minimum songs
          <input
            type="number"
            min="1"
            value={minSongs}
            onChange={(e) => {
              const value = e.target.value;
              setMinSongs(value);
              const numeric = Math.max(1, Math.floor(Number(value) || 1));
              if (Number(maxSongs) < numeric) setMaxSongs(numeric);
            }}
            style={{ width: "100%", marginTop: 6 }}
          />
        </label>

        <label style={{ fontSize: 13, fontWeight: 600 }}>
          Maximum songs
          <input
            type="number"
            min={Math.max(1, Number(minSongs) || 1)}
            value={maxSongs}
            onChange={(e) => setMaxSongs(e.target.value)}
            style={{ width: "100%", marginTop: 6 }}
          />
        </label>
      </div>

      <p style={{ color: "var(--text-secondary)", fontSize: 13, margin: "10px 0 0" }}>
        Viewers can submit between <strong>{Math.max(1, Number(minSongs) || 1)}</strong> and{" "}
        <strong>{Math.max(Math.max(1, Number(minSongs) || 1), Number(maxSongs) || 1)}</strong> songs.
        If they run out during the tournament, their submitted songs replay again in the same order.
      </p>

      {settingsErr && (
        <p style={{ color: "var(--text-danger)", fontSize: 13 }}>{settingsErr}</p>
      )}

      <button
        type="button"
        onClick={save}
        style={{
          marginTop: 14,
          background: "var(--spark)",
          color: "var(--stage-void)",
          fontWeight: 700,
          padding: "10px 14px",
          border: "none",
        }}
      >
        Save contest settings
      </button>

      {saved && (
        <span style={{ marginLeft: 10, fontSize: 13, color: "var(--text-secondary)" }}>
          Saved — public page updated.
        </span>
      )}
    </div>
  );
}

function AdminView() {
  // Contest settings are rendered in the admin panel below.
  const [unlocked, setUnlocked] = useState(false);
  const [checking, setChecking] = useState(true);

  useEffect(() => {
    (async () => {
      const savedHash = localStorage.getItem(ADMIN_SESSION_KEY);
      if (savedHash) {
        const realHash = await getAdminPasswordHash();
        if (realHash && savedHash === realHash) {
          setUnlocked(true);
        }
      }
      setChecking(false);
    })();
  }, []);

  if (checking) return <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>;
  if (!unlocked) return <AdminLock onUnlock={() => setUnlocked(true)} />;
  return <AdminPanel />;
}

function AdminPanel() {
  const [t, setT] = useState(null);
  const [subs, setSubs] = useState([]);
  const [nameInput, setNameInput] = useState("");
  const [songInput, setSongInput] = useState("");
  const [tab, setTab] = useState("setup");
  const [err, setErr] = useState("");
  const pollRef = useRef(null);

  useEffect(() => {
    (async () => {
      setT(await loadState());
      setSubs(await loadSubs());
    })();
    pollRef.current = setInterval(async () => {
      setSubs(await loadSubs());
    }, 4000);
    return () => clearInterval(pollRef.current);
  }, []);

  const persist = async (next) => {
    setT(next);
    await saveState(next);
  };

  const addEntrant = () => {
    const songs = songInput.split("\n").map((s) => s.trim()).filter(Boolean);
    if (!nameInput.trim() || songs.length === 0) {
      setErr("Enter a name and at least one song");
      return;
    }
    setErr("");
    const next = { ...t, entrants: [...t.entrants, { id: uid(), name: nameInput.trim(), songs, songsUsed: 0 }] };
    setNameInput("");
    setSongInput("");
    persist(next);
  };

  const removeEntrant = (id) => {
    persist({ ...t, entrants: t.entrants.filter((e) => e.id !== id) });
  };

  const approveSub = async (s) => {
    const songs = Array.isArray(s.songs) ? s.songs : (s.song ? [s.song] : []);
    const next = { ...t, entrants: [...t.entrants, { id: uid(), name: s.name, songs, songsUsed: 0 }] };
    await persist(next);
    await deleteSubmission(s.id);
    setSubs(subs.filter((x) => x.id !== s.id));
  };

  const rejectSub = async (s) => {
    await deleteSubmission(s.id);
    setSubs(subs.filter((x) => x.id !== s.id));
  };

  const shuffleEntrants = () => {
    const shuffled = [...t.entrants];
    for (let i = shuffled.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    persist({ ...t, entrants: shuffled });
  };

  const startTournament = () => {
    if (t.entrants.length < 2) {
      setErr("Need at least 2 entrants");
      return;
    }
    setErr("");
    const b = buildBracket(t.entrants);
    let next = { ...t, ...b, status: "running", votes: { a: 0, b: 0 }, votingOpen: false };
    next = autoResolveByes(next);
    persist(next);
    setTab("bracket");
  };

  const pickWinner = (bracketName, ri, mi, winner) => {
    const next = structuredClone(t);
    const bracket = bracketName === "losers" ? next.losers : next.winners;
    const match = bracket?.[ri]?.[mi];

    if (!match || match.winner || !match.a || !match.b) return;
    if (winner.id !== match.a.id && winner.id !== match.b.id) return;

    match.winner = { ...winner };
    match.loser = winner.id === match.a.id ? { ...match.b } : { ...match.a };

    // A song is consumed when the entrant finishes a match, regardless of
    // whether they won or lost. This keeps the next-round song aligned.
    advanceEntrantSong(next, match.winner.id);
    advanceEntrantSong(next, match.loser.id);

    propagate(next);
    next = autoResolveByes(next);
    next.votes = { a: 0, b: 0 };
    next.votingOpen = false;

    try {
      persist(next);
    } catch (e) {
      console.error("Failed to persist winner:", e);
    }
  };

  const pickGrandFinalWinner = (entrant) => {
    if (!t.grandFinal || t.grandFinal.winner || !entrant) return;
    if (!t.grandFinal.a || !t.grandFinal.b) return;
    if (entrant.id !== t.grandFinal.a.id && entrant.id !== t.grandFinal.b.id) return;

    const next = structuredClone(t);
    next.grandFinal.winner = { ...entrant };

    const loser = entrant.id === next.grandFinal.a.id
      ? next.grandFinal.b
      : next.grandFinal.a;

    advanceEntrantSong(next, entrant.id);
    if (loser) advanceEntrantSong(next, loser.id);

    next.status = "done";
    next.votingOpen = false;
    next.votes = { a: 0, b: 0 };

    persist(next);
  };

  const toggleVoting = () => {
    persist({ ...t, votingOpen: !t.votingOpen, votes: { a: 0, b: 0 } });
  };
  const resetVotes = () => {
    persist({ ...t, votes: { a: 0, b: 0 } });
  };
  const bumpVote = (side) => {
    const next = { ...t, votes: { ...t.votes, [side]: t.votes[side] + 1 } };
    persist(next);
  };

  const resetAll = () => {
    if (!confirm("Reset the whole tournament? Entrants list is kept, bracket is cleared.")) return;
    const resetEntrants = t.entrants.map((e) => ({ ...e, songsUsed: 0 }));
    persist({ ...emptyTournament(), name: t.name, entrants: resetEntrants });
  };

  if (!t) return <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "flex-start", justifyContent: "space-between", marginBottom: 24 }}>
        <div>
          <div style={{ fontSize: 12.5, letterSpacing: "0.04em", color: "var(--spark)", fontWeight: 700, marginBottom: 4 }}>Backstage</div>
          <h1 style={{ fontSize: 34 }}>{t.name}</h1>
        </div>
        <span
          style={{
            fontSize: 12,
            fontWeight: 700,
            padding: "6px 12px",
            borderRadius: 20,
            background: t.status === "setup" ? "rgba(255,205,74,0.12)" : t.status === "done" ? "rgba(107,214,138,0.14)" : "rgba(255,79,126,0.12)",
            color: t.status === "setup" ? "var(--gold)" : t.status === "done" ? "var(--ok)" : "var(--spark)",
            border: "1px solid currentColor",
          }}
        >
          {t.status}
        </span>
      </div>

      <div style={{ display: "flex", gap: 6, marginBottom: 24, borderBottom: "1px solid var(--border)", paddingBottom: 2 }}>
        {["setup", "bracket", "voting"].map((tb) => (
          <button
            key={tb}
            onClick={() => setTab(tb)}
            style={{
              background: "transparent",
              border: "none",
              borderBottom: tab === tb ? "2px solid var(--spark)" : "2px solid transparent",
              borderRadius: 0,
              color: tab === tb ? "var(--text-primary)" : "var(--text-muted)",
              fontWeight: tab === tb ? 700 : 500,
              padding: "8px 4px",
              marginRight: 20,
            }}
          >
            {tb === "setup" ? "Queue & entrants" : tb === "bracket" ? "Bracket" : "Live voting"}
          </button>
        ))}
      </div>

      {tab === "setup" && (
        <div>
          <AdminContestSettings t={t} onSave={persist} />

          <div style={{ marginBottom: 28 }}>
            <div style={{ display: "flex", alignItems: "baseline", gap: 8, marginBottom: 12 }}>
              <h2 style={{ fontSize: 20 }}>Queue</h2>
              <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{subs.length} waiting</span>
            </div>
            {subs.length === 0 ? (
              <div style={{ padding: "24px 20px", textAlign: "center", background: "var(--stage-card)", border: "1px dashed var(--border)", borderRadius: "var(--radius)" }}>
                <p style={{ margin: 0, fontSize: 13.5 }}>Nothing waiting for review. New entries will show up here as viewers submit.</p>
              </div>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 10 }}>
                {subs.map((s) => (
                  <div
                    key={s.id}
                    style={{
                      background: "var(--stage-card)",
                      border: "1px solid var(--border)",
                      borderRadius: "var(--radius)",
                      padding: "14px 16px",
                    }}
                  >
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", gap: 12 }}>
                      <div>
                        <div style={{ fontWeight: 700, fontSize: 15.5, marginBottom: 6 }}>{s.name}</div>
                        <ol style={{ margin: 0, paddingLeft: 18, fontSize: 13.5, color: "var(--text-secondary)", display: "flex", flexDirection: "column", gap: 2 }}>
                          {(s.songs || []).map((song, i) => (
                            <li key={i}>{song}</li>
                          ))}
                        </ol>
                      </div>
                      <div style={{ display: "flex", gap: 6, flexShrink: 0 }}>
                        <button
                          onClick={() => approveSub(s)}
                          style={{ background: "var(--ok)", color: "var(--stage-void)", fontWeight: 700, border: "none", padding: "8px 14px" }}
                        >
                          Approve
                        </button>
                        <button
                          onClick={() => rejectSub(s)}
                          style={{ background: "transparent", color: "var(--text-muted)" }}
                        >
                          Reject
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginBottom: 28 }}>
            <h2 style={{ fontSize: 20, marginBottom: 12 }}>Add entrant manually</h2>
            <div style={{ background: "var(--stage-card)", border: "1px solid var(--border)", borderRadius: "var(--radius)", padding: 16, display: "flex", flexDirection: "column", gap: 10 }}>
              <input placeholder="Viewer name" value={nameInput} onChange={(e) => setNameInput(e.target.value)} />
              <textarea
                placeholder={"One song per line, in the order they should be played"}
                value={songInput}
                onChange={(e) => setSongInput(e.target.value)}
                rows={3}
              />
              <button onClick={addEntrant} style={{ alignSelf: "flex-start", background: "var(--spark)", color: "var(--stage-void)", fontWeight: 700, border: "none" }}>
                Add entrant
              </button>
              {err && <p style={{ color: "var(--spark)", fontSize: 13, margin: 0 }}>{err}</p>}
            </div>
          </div>

          <div>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
              <div style={{ display: "flex", alignItems: "baseline", gap: 8 }}>
                <h2 style={{ fontSize: 20 }}>Entrants</h2>
                <span style={{ fontSize: 13, color: "var(--text-muted)" }}>{t.entrants.length}</span>
              </div>
              {t.entrants.length > 1 && (
                <button onClick={shuffleEntrants} style={{ background: "transparent", color: "var(--text-secondary)" }}>
                  Shuffle order
                </button>
              )}
            </div>
            {t.entrants.length === 0 ? (
              <p style={{ fontSize: 13.5 }}>No entrants yet — approve submissions or add someone manually above.</p>
            ) : (
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {t.entrants.map((e) => (
                  <div
                    key={e.id}
                    style={{
                      display: "flex",
                      justifyContent: "space-between",
                      alignItems: "center",
                      background: "var(--stage-card)",
                      border: "1px solid var(--border)",
                      padding: "10px 14px",
                      borderRadius: 10,
                    }}
                  >
                    <span style={{ fontSize: 14 }}>
                      <strong>{e.name}</strong>
                      <span style={{ color: "var(--text-muted)" }}> — {(e.songs || []).length} song{(e.songs || []).length === 1 ? "" : "s"}, {(e.songsUsed || 0)} used</span>
                    </span>
                    <button onClick={() => removeEntrant(e.id)} aria-label="Remove" style={{ background: "transparent", color: "var(--text-muted)", padding: "4px 8px" }}>
                      ✕
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          <div style={{ marginTop: 28, display: "flex", gap: 10 }}>
            <button
              onClick={startTournament}
              style={{ background: "var(--spark)", color: "var(--stage-void)", fontWeight: 700, border: "none", padding: "12px 20px" }}
            >
              {t.status === "setup" ? "Build bracket & start" : "Rebuild bracket"}
            </button>
            {t.status !== "setup" && (
              <button onClick={resetAll} style={{ background: "transparent", color: "var(--text-secondary)" }}>
                Reset tournament
              </button>
            )}
          </div>
        </div>
      )}

      {tab === "bracket" && (
        <div>
          {t.status === "setup" ? (
            <p style={{ color: "var(--text-muted)" }}>Add entrants and start the tournament first.</p>
          ) : (
            <div style={{ display: "flex", flexDirection: "column", gap: 32 }}>
              <BracketColumn title="Winners bracket" rounds={t.winners} anonymous={false} editable onPick={pickWinner} labelPrefix="W" />
              {t.losers.length > 0 && (
                <BracketColumn title="Losers bracket" rounds={t.losers} anonymous={false} editable onPick={pickWinner} labelPrefix="L" />
              )}
              {t.grandFinal && (
                <div>
                  <h3>Grand final</h3>
                  <MatchCard m={t.grandFinal} label="Grand final" anonymous={false} editable onPick={pickGrandFinalWinner} />
                </div>
              )}
              {t.grandFinal?.winner && (
                <div style={{ background: "var(--bg-success)", border: "0.5px solid var(--border-success)", borderRadius: 10, padding: 16, textAlign: "center" }}>
                  <p style={{ margin: 0, fontSize: 16, fontWeight: 500, color: "var(--text-success)" }}>
                    Winner: {t.grandFinal.winner.name} — {currentSongFor(t.grandFinal.winner)}
                  </p>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {tab === "voting" && (
        <div>
          {t.status === "setup" ? (
            <p style={{ color: "var(--text-muted)" }}>Start the tournament to enable voting.</p>
          ) : (
            <div>
              <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>
                Voting is manual-count here: watch Twitch chat for 1 / 2 and click the buttons below, or wire up a chat bot later to call the same store. This panel is what your OBS overlay reads from live.
              </p>
              <div style={{ display: "flex", gap: 8, marginBottom: 16 }}>
                <button onClick={toggleVoting} style={{ borderColor: t.votingOpen ? "var(--border-danger)" : "var(--border-accent)", color: t.votingOpen ? "var(--text-danger)" : "var(--text-accent)" }}>
                  {t.votingOpen ? "Close voting" : "Open voting"}
                </button>
                <button onClick={resetVotes}><i className="ti ti-refresh" aria-hidden="true" /> Reset votes</button>
              </div>
              <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
                {["a", "b"].map((side) => (
                  <div key={side} style={{ background: "var(--surface-1)", borderRadius: 10, padding: 16, textAlign: "center" }}>
                    <div style={{ fontSize: 13, color: "var(--text-muted)", marginBottom: 6 }}>Song {side === "a" ? "1" : "2"}</div>
                    <div style={{ fontSize: 32, fontWeight: 500, marginBottom: 10 }}>{t.votes[side]}</div>
                    <button onClick={() => bumpVote(side)} disabled={!t.votingOpen}>+1 (manual)</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function currentMatch(t) {
  if (!t) return null;
  if (t.grandFinal && !t.grandFinal.winner && t.grandFinal.a && t.grandFinal.b) {
    return { m: t.grandFinal, label: "Grand final" };
  }
  const scan = (bracket, prefix) => {
    for (let r = 0; r < bracket.length; r++) {
      for (let i = 0; i < bracket[r].length; i++) {
        const m = bracket[r][i];
        if (!m.winner && m.a && m.b) return { m, label: `${prefix} round ${r + 1}, match ${i + 1}` };
      }
    }
    return null;
  };
  return scan(t.winners, "Winners") || scan(t.losers, "Losers") || null;
}

function PublicView() {
  const [t, setT] = useState(null);
  useEffect(() => {
    let mounted = true;
    const tick = async () => {
      const s = await loadState();
      if (mounted) setT(s);
    };
    tick();
    const id = setInterval(tick, 3000);
    return () => { mounted = false; clearInterval(id); };
  }, []);
  if (!t) return null;

  const cm = currentMatch(t);

  return (
    <div>
      <h1 style={{ margin: "0 0 4px" }}>{t.name}</h1>
      <p style={{ margin: "0 0 20px", fontSize: 13, color: "var(--text-secondary)" }}>Song identities stay hidden until results are in.</p>

      {cm && (
        <div style={{ background: "var(--surface-1)", borderRadius: 12, padding: 20, marginBottom: 28, textAlign: "center" }}>
          <div style={{ fontSize: 12, color: "var(--text-muted)", marginBottom: 12 }}>{cm.label}</div>
          <div style={{ display: "flex", gap: 16, justifyContent: "center", alignItems: "center" }}>
            <div style={{ background: "var(--surface-2)", border: "0.5px solid var(--border)", borderRadius: 10, padding: "16px 24px", minWidth: 140 }}>
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Song 1</div>
              <div style={{ fontSize: 22, fontWeight: 500, marginTop: 6 }}>{t.votes.a}</div>
            </div>
            <span style={{ fontSize: 13, color: "var(--text-muted)" }}>vs</span>
            <div style={{ background: "var(--surface-2)", border: "0.5px solid var(--border)", borderRadius: 10, padding: "16px 24px", minWidth: 140 }}>
              <div style={{ fontSize: 13, color: "var(--text-muted)" }}>Song 2</div>
              <div style={{ fontSize: 22, fontWeight: 500, marginTop: 6 }}>{t.votes.b}</div>
            </div>
          </div>
          <div style={{ marginTop: 14, fontSize: 13, color: t.votingOpen ? "var(--text-success)" : "var(--text-muted)" }}>
            {t.votingOpen ? "Voting open — type 1 or 2 in chat" : "Voting closed"}
          </div>
        </div>
      )}

      {t.status === "setup" && <p style={{ color: "var(--text-muted)" }}>Bracket hasn't started yet.</p>}

      {t.status !== "setup" && (
        <div style={{ display: "flex", flexDirection: "column", gap: 28 }}>
          <BracketColumn title="Winners bracket" rounds={t.winners} anonymous={false} editable={false} onPick={() => {}} labelPrefix="W" />
          {t.losers.length > 0 && (
            <BracketColumn title="Losers bracket" rounds={t.losers} anonymous editable={false} onPick={() => {}} labelPrefix="L" />
          )}
          {t.grandFinal && (
            <div>
              <h3>Grand final</h3>
              <MatchCard m={t.grandFinal} label="Grand final" anonymous editable={false} onPick={() => {}} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function OverlayView() {
  const [t, setT] = useState(null);
  useEffect(() => {
    let mounted = true;
    const tick = async () => {
      const s = await loadState();
      if (mounted) setT(s);
    };
    tick();
    const id = setInterval(tick, 2000);
    return () => { mounted = false; clearInterval(id); };
  }, []);
  if (!t) return null;
  const cm = currentMatch(t);
  if (!cm) {
    return (
      <div style={{ padding: 24, textAlign: "center", color: "var(--text-muted)", fontSize: 14 }}>
        No active match
      </div>
    );
  }
  return (
    <div style={{ padding: "12px 4px", maxWidth: 520 }}>
      <div style={{ display: "flex", gap: 12, alignItems: "stretch" }}>
        <div style={{ flex: 1, background: "var(--surface-2)", border: "1.5px solid var(--border-accent)", borderRadius: 12, padding: "18px 12px", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "var(--text-accent)", fontWeight: 500 }}>Song 1</div>
          <div style={{ fontSize: 30, fontWeight: 500, marginTop: 8 }}>{t.votes.a}</div>
        </div>
        <div style={{ display: "flex", alignItems: "center", fontSize: 13, color: "var(--text-muted)" }}>VS</div>
        <div style={{ flex: 1, background: "var(--surface-2)", border: "1.5px solid var(--border-accent)", borderRadius: 12, padding: "18px 12px", textAlign: "center" }}>
          <div style={{ fontSize: 13, color: "var(--text-accent)", fontWeight: 500 }}>Song 2</div>
          <div style={{ fontSize: 30, fontWeight: 500, marginTop: 8 }}>{t.votes.b}</div>
        </div>
      </div>
      <div style={{ textAlign: "center", marginTop: 10, fontSize: 12, color: t.votingOpen ? "var(--text-success)" : "var(--text-muted)" }}>
        {t.votingOpen ? "Type 1 or 2 in chat to vote" : "Voting closed"}
      </div>
    </div>
  );
}

function getContestSettings(t) {
  const minSongs = Math.max(1, Number(t?.minSongs || t?.requiredSongs || 3));
  const maxSongs = Math.max(
    minSongs,
    Number(t?.maxSongs || t?.requiredSongs || minSongs)
  );

  return {
    contestNumber: Number(t?.contestNumber || 1),
    minSongs,
    maxSongs,
  };
}

function RulesGate({ settings, onContinue }) {
  const [accepted, setAccepted] = useState(false);

  return (
    <div style={{ maxWidth: 620, margin: "3rem auto", textAlign: "center", padding: "0 1rem" }}>
      <div style={{ color: "var(--spark)", fontWeight: 700, fontSize: 13, letterSpacing: ".06em" }}>
        KYLEVISION
      </div>
      <h1 style={{ fontSize: 42, marginTop: 8 }}>
        Welcome to KyleVision Song Contest #{settings.contestNumber}
      </h1>

      <div
        style={{
          marginTop: 24,
          textAlign: "left",
          background: "var(--stage-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 24,
        }}
      >
        <h2 style={{ marginTop: 0 }}>Before you enter</h2>
        <p>
          Please read the rules before submitting your songs. Entries are reviewed before
          they can be accepted into the tournament.
        </p>

        <ul style={{ lineHeight: 1.7, paddingLeft: 22 }}>
          <li>No troll songs.</li>
          <li>No anime songs or other entries that aren't suitable for a serious music tournament.</li>
          <li>Only submit songs you genuinely think belong in the competition.</li>
          <li>You must enter your Twitch username accurately.</li>
          <li>Using a fake or misleading Twitch name can result in being banned from future music tournaments.</li>
          <li>You've been warned: inappropriate or troll submissions may simply be rejected.</li>
          <li>
            You must submit between <strong>{settings.minSongs} and {settings.maxSongs} songs</strong>.
          </li>
          <li>
            If you submit fewer songs than are needed to get through the tournament, your older
            submitted songs will be replayed again in the same order you entered them.
          </li>
        </ul>

        <label
          style={{
            display: "flex",
            gap: 10,
            alignItems: "flex-start",
            marginTop: 22,
            cursor: "pointer",
            fontSize: 14,
          }}
        >
          <input
            type="checkbox"
            checked={accepted}
            onChange={(e) => setAccepted(e.target.checked)}
            style={{ width: 18, height: 18, marginTop: 1 }}
          />
          <span>I have read the rules and agree to follow them.</span>
        </label>

        <button
          type="button"
          disabled={!accepted}
          onClick={onContinue}
          style={{
            width: "100%",
            marginTop: 20,
            padding: "13px 16px",
            background: accepted ? "var(--spark)" : "var(--surface-1)",
            color: accepted ? "var(--stage-void)" : "var(--text-muted)",
            fontWeight: 700,
            border: "none",
          }}
        >
          Continue to submission
        </button>
      </div>
    </div>
  );
}

function SongTextInput({ onAdd, disabled }) {
  const [song, setSong] = useState("");

  const add = () => {
    const clean = song.trim();
    if (!clean || disabled) return;
    onAdd(clean);
    setSong("");
  };

  return (
    <div style={{ marginBottom: 20 }}>
      <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>
        Recommend a song
      </label>

      <div style={{ display: "flex", gap: 8 }}>
        <input
          type="text"
          value={song}
          onChange={(e) => setSong(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") {
              e.preventDefault();
              add();
            }
          }}
          placeholder="Artist — Song"
          disabled={disabled}
          style={{ flex: 1 }}
        />
        <button
          type="button"
          onClick={add}
          disabled={disabled || !song.trim()}
          style={{ padding: "0 16px", fontWeight: 700 }}
        >
          Add
        </button>
      </div>
    </div>
  );
}

function SubmitView() {
  const [t, setT] = useState(null);
  const [acceptedRules, setAcceptedRules] = useState(false);
  const [entrantName, setEntrantName] = useState("");
  const [submittedSongs, setSubmittedSongs] = useState([]);
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");

  useEffect(() => {
    let alive = true;

    const load = async () => {
      try {
        const next = await loadState();
        if (alive) setT(next);
      } catch (e) {
        console.error(e);
      }
    };

    load();

    // Polling keeps the public form in sync with admin changes without
    // requiring a page refresh.
    const timer = setInterval(load, 2000);
    return () => {
      alive = false;
      clearInterval(timer);
    };
  }, []);

  if (!t) {
    return <div style={{ textAlign: "center", padding: "4rem 1rem" }}>Loading contest…</div>;
  }

  const settings = getContestSettings(t);

  if (!acceptedRules) {
    return (
      <RulesGate
        settings={settings}
        onContinue={() => setAcceptedRules(true)}
      />
    );
  }

  if (sent) {
    return (
      <div style={{ maxWidth: 460, margin: "4rem auto", textAlign: "center", padding: "0 1rem" }}>
        <h1>Submission received</h1>
        <p style={{ marginTop: 10 }}>
          Your entry has been sent for review. Good luck in KyleVision #{settings.contestNumber}!
        </p>
        <button
          onClick={() => {
            setSent(false);
            setAcceptedRules(false);
            setEntrantName("");
            setSubmittedSongs([]);
            setErr("");
          }}
          style={{ marginTop: 20 }}
        >
          Submit another entry
        </button>
      </div>
    );
  }

  const addSong = (song) => {
    if (submittedSongs.length >= settings.maxSongs) {
      setErr(`You can only submit up to ${settings.maxSongs} songs.`);
      return;
    }
    setSubmittedSongs((prev) => [...prev, song]);
    setErr("");
  };

  const removeSong = (idx) => {
    setSubmittedSongs((prev) => prev.filter((_, i) => i !== idx));
    setErr("");
  };

  const handleFormSubmit = async (e) => {
    e.preventDefault();

    const cleanName = entrantName.trim();
    const cleanSongs = submittedSongs.map((s) => s.trim()).filter(Boolean);

    if (!cleanName) {
      setErr("You must enter your Twitch name.");
      return;
    }

    if (cleanSongs.length < settings.minSongs || cleanSongs.length > settings.maxSongs) {
      setErr(`You must select between ${settings.minSongs} and ${settings.maxSongs} songs.`);
      return;
    }

    try {
      await addSubmission(cleanName, cleanSongs);
      setEntrantName("");
      setSubmittedSongs([]);
      setErr("");
      setSent(true);
    } catch (e) {
      console.error("Submission error:", e);
      setErr("Couldn't submit right now. Please try again.");
    }
  };

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "1rem 0 3rem" }}>
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{ fontSize: 13, color: "var(--spark)", fontWeight: 700 }}>
          KYLEVISION SONG CONTEST #{settings.contestNumber}
        </div>
        <h1 style={{ fontSize: 40 }}>Submit your entry</h1>
        <p style={{ marginTop: 8 }}>
          Select between <strong>{settings.minSongs}</strong> and{" "}
          <strong>{settings.maxSongs}</strong> songs.
          The range can be changed by the admin at any time. If your songs run out during
          the tournament, your older songs will be replayed again in the same order you entered them.
        </p>
      </div>

      <form
        onSubmit={handleFormSubmit}
        style={{
          background: "var(--stage-card)",
          border: "1px solid var(--border)",
          borderRadius: "var(--radius)",
          padding: 22,
        }}
      >
        <div style={{ marginBottom: 18 }}>
          <label style={{ display: "block", fontSize: 13, fontWeight: 600, color: "var(--text-secondary)", marginBottom: 6 }}>
            Twitch username
          </label>
          <input
            type="text"
            value={entrantName}
            onChange={(e) => setEntrantName(e.target.value)}
            placeholder="Your Twitch name"
            required
            style={{ width: "100%" }}
          />
        </div>

        <SongTextInput
          onAdd={addSong}
          disabled={submittedSongs.length >= settings.maxSongs}
        />

        <div style={{ marginBottom: 15 }}>
          <h4 style={{ marginBottom: 8 }}>
            Selected Songs ({submittedSongs.length}/{settings.maxSongs})
          </h4>

          {submittedSongs.length === 0 ? (
            <p style={{ fontSize: 13, color: "var(--text-muted)" }}>
              No songs selected yet.
            </p>
          ) : (
            <ol style={{ paddingLeft: 20, margin: 0 }}>
              {submittedSongs.map((song, idx) => (
                <li
                  key={`${song}-${idx}`}
                  style={{
                    margin: "6px 0",
                    fontSize: 14,
                    display: "flex",
                    justifyContent: "space-between",
                    gap: 8,
                    alignItems: "center",
                  }}
                >
                  <span>{song}</span>
                  <button
                    type="button"
                    onClick={() => removeSong(idx)}
                    style={{
                      background: "transparent",
                      color: "var(--text-muted)",
                      padding: "2px 6px",
                    }}
                  >
                    ✕
                  </button>
                </li>
              ))}
            </ol>
          )}
        </div>

        {err && (
          <p style={{ color: "var(--spark)", fontSize: 13.5, marginTop: 14 }}>
            {err}
          </p>
        )}

        <button
          type="submit"
          disabled={
            !entrantName.trim() ||
            submittedSongs.length < settings.minSongs ||
            submittedSongs.length > settings.maxSongs
          }
          style={{
            marginTop: 20,
            width: "100%",
            background={
              submittedSongs.length >= settings.minSongs && submittedSongs.length <= settings.maxSongs
                ? "var(--spark)"
                : "var(--surface-1)"
            },
            color={
              submittedSongs.length >= settings.minSongs && submittedSongs.length <= settings.maxSongs
                ? "var(--stage-void)"
                : "var(--text-muted)"
            },
            fontWeight: 700,
            fontSize: 16,
            padding: "13px 16px",
            border: "none",
          }}
        >
          Submit to Bracket Queue
        </button>
      </form>
    </div>
  );
}

function getViewFromPath() {
  const path = window.location.pathname.replace(/^\/+|\/+$/g, "").toLowerCase();

  if (path === "admin") return "admin";
  if (path === "public") return "public";
  if (path === "overlay") return "overlay";
  if (path === "submit") return "submit";

  // The root URL is the public submission page.
  return "submit";
}

export default function App() {
  const initial = getViewFromPath();
  const [view, setView] = useState(initial);
  const isDedicatedRoute = window.location.pathname.replace(/^\/+|\/+$/g, "") !== "";

  useEffect(() => {
    const onPopState = () => setView(getViewFromPath());
    window.addEventListener("popstate", onPopState);
    return () => window.removeEventListener("popstate", onPopState);
  }, []);

  const goTo = (v) => {
    setView(v);
    window.history.pushState({}, "", `/${v}`);
  };

  return (
    <div style={{ padding: "1.5rem 1rem", maxWidth: 900, margin: "0 auto" }}>
      {!isDedicatedRoute && (
        <div style={{ display: "flex", gap: 6, marginBottom: 24, flexWrap: "wrap" }}>
          {[
            ["admin", "Admin (mod only)"],
            ["public", "Public bracket"],
            ["overlay", "OBS overlay"],
            ["submit", "Submit song"],
          ].map(([k, label]) => (
            <button
              key={k}
              onClick={() => goTo(k)}
              style={{
                fontSize: 12,
                padding: "6px 10px",
                background: view === k ? "var(--surface-1)" : "transparent",
                fontWeight: view === k ? 500 : 400,
              }}
            >
              {label}
            </button>
          ))}
        </div>
      )}

      {view === "admin" && <AdminView />}
      {view === "public" && <PublicView />}
      {view === "overlay" && <OverlayView />}
      {view === "submit" && <SubmitView />}
    </div>
  );
}
