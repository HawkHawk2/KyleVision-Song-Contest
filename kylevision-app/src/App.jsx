import { useState, useEffect, useCallback, useRef } from "react";

const uid = () => Math.random().toString(36).slice(2, 10);
const STATE_KEY = "kv-tournament-v1";
const SUBS_KEY = "kv-submissions-v1";

const emptyTournament = () => ({
  id: uid(),
  name: "KyleVision",
  status: "setup", // setup | running | done
  entrants: [], // {id, name, song, artist}
  winners: [], // rounds: [ [match,...], [match,...] ]
  losers: [],
  grandFinal: null, // match
  votingOpen: false,
  votes: { a: 0, b: 0 },
  activeMatchPath: null, // {bracket:'winners'|'losers'|'final', round, index}
});

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
  // push winners bracket winners forward into next round
  for (let r = 0; r < t.winners.length - 1; r++) {
    const cur = t.winners[r];
    const next = t.winners[r + 1];
    for (let i = 0; i < cur.length; i++) {
      const m = cur[i];
      const slot = next[Math.floor(i / 2)];
      if (m.winner) {
        if (i % 2 === 0) slot.a = m.winner;
        else slot.b = m.winner;
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
      if (i % 2 === 0) slot.a = loser;
      else slot.b = loser;
    }
  }
  // propagate losers bracket forward + feed subsequent winners-round losers in
  for (let r = 0; r < t.losers.length; r++) {
    const cur = t.losers[r];
    let next = t.losers[r + 1];
    if (!next) {
      next = Array.from({ length: Math.max(1, Math.ceil(cur.length / 2)) }, () => makeMatch(null, null));
      t.losers.push(next);
    }
    for (let i = 0; i < cur.length; i++) {
      const m = cur[i];
      if (!m.winner) continue;
      const slot = next[Math.floor(i / 2)];
      if (!slot.a) slot.a = m.winner;
      else if (!slot.b && slot.a.id !== m.winner.id) slot.b = m.winner;
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
      if (!slot.a) slot.a = loser;
      else if (!slot.b) slot.b = loser;
    }
  }
  // set up grand final once both finals resolved
  const wFinal = t.winners[t.winners.length - 1]?.[0];
  const lFinalRound = t.losers[t.losers.length - 1];
  const lFinal = lFinalRound ? lFinalRound[lFinalRound.length - 1] : null;
  if (wFinal?.winner && lFinal?.winner && !t.grandFinal) {
    t.grandFinal = makeMatch(wFinal.winner, lFinal.winner);
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
  try {
    const rows = await sb("tournament_state?id=eq.main&select=data");
    if (rows && rows.length > 0) return rows[0].data;
    return emptyTournament();
  } catch (e) {
    console.error("load failed", e);
    return emptyTournament();
  }
}
async function saveState(t) {
  try {
    await sb("tournament_state?id=eq.main", {
      method: "PATCH",
      body: JSON.stringify({ data: t }),
    });
  } catch (e) {
    console.error("save failed", e);
  }
}
async function loadSubs() {
  try {
    const rows = await sb("submissions?select=id,name,song&order=created_at.asc");
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
async function addSubmission(name, song) {
  await sb("submissions", {
    method: "POST",
    body: JSON.stringify([{ id: uid(), name, song }]),
  });
}
async function deleteSubmission(id) {
  await sb(`submissions?id=eq.${id}`, { method: "DELETE" });
}

function nameFor(entrant, anonymous, label) {
  if (!entrant) return null;
  return anonymous ? label : `${entrant.name} — ${entrant.song}`;
}

function MatchCard({ m, label, anonymous, onPick, editable }) {
  const isDone = !!m.winner;
  const pick = (side) => {
    if (!editable) return;
    const chosen = side === "a" ? m.a : m.b;
    if (!chosen || (m.a && m.b == null) || (m.b && m.a == null)) {
      // allow picking even with a bye present, guard below handles null
    }
    if (!chosen) return;
    onPick(chosen);
  };
  const row = (side, entrant) => {
    const won = isDone && entrant && m.winner.id === entrant.id;
    const lost = isDone && entrant && m.winner.id !== entrant.id;
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
        {won && <i className="ti ti-check" style={{ fontSize: 14, color: "var(--text-success)" }} aria-hidden="true" />}
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

function AdminView() {
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
    if (!nameInput.trim() || !songInput.trim()) {
      setErr("Enter both a name and a song");
      return;
    }
    setErr("");
    const next = { ...t, entrants: [...t.entrants, { id: uid(), name: nameInput.trim(), song: songInput.trim() }] };
    setNameInput("");
    setSongInput("");
    persist(next);
  };

  const removeEntrant = (id) => {
    persist({ ...t, entrants: t.entrants.filter((e) => e.id !== id) });
  };

  const approveSub = async (s) => {
    const next = { ...t, entrants: [...t.entrants, { id: uid(), name: s.name, song: s.song }] };
    await persist(next);
    await deleteSubmission(s.id);
    setSubs(subs.filter((x) => x.id !== s.id));
  };

  const rejectSub = async (s) => {
    await deleteSubmission(s.id);
    setSubs(subs.filter((x) => x.id !== s.id));
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
    bracket[ri][mi].winner = winner;
    propagate(next);
    next.votes = { a: 0, b: 0 };
    next.votingOpen = false;
    persist(next);
  };

  const pickGrandFinalWinner = (entrant) => {
    const next = structuredClone(t);
    next.grandFinal.winner = entrant;
    next.status = "done";
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
    persist({ ...emptyTournament(), name: t.name, entrants: t.entrants });
  };

  if (!t) return <div style={{ padding: "2rem", textAlign: "center", color: "var(--text-muted)" }}>Loading…</div>;

  return (
    <div>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <h1 style={{ margin: 0 }}>{t.name} — admin</h1>
          <p style={{ margin: "4px 0 0", fontSize: 13, color: "var(--text-secondary)" }}>
            Only you should have this link. Real names and songs are visible here.
          </p>
        </div>
        <span style={{ fontSize: 12, padding: "4px 10px", borderRadius: 20, background: "var(--surface-1)", border: "0.5px solid var(--border)" }}>
          {t.status}
        </span>
      </div>

      <div style={{ display: "flex", gap: 8, marginBottom: 20 }}>
        {["setup", "bracket", "voting"].map((tb) => (
          <button
            key={tb}
            onClick={() => setTab(tb)}
            style={{
              background: tab === tb ? "var(--surface-1)" : "transparent",
              fontWeight: tab === tb ? 500 : 400,
            }}
          >
            {tb === "setup" ? "Setup & entrants" : tb === "bracket" ? "Bracket" : "Live voting"}
          </button>
        ))}
      </div>

      {tab === "setup" && (
        <div>
          {subs.length > 0 && (
            <div style={{ marginBottom: 24 }}>
              <h3>Pending submissions ({subs.length})</h3>
              <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
                {subs.map((s) => (
                  <div key={s.id} style={{ display: "flex", alignItems: "center", justifyContent: "space-between", background: "var(--surface-1)", padding: "8px 12px", borderRadius: 8 }}>
                    <span style={{ fontSize: 13 }}>
                      <strong style={{ fontWeight: 500 }}>{s.name}</strong> — {s.song}
                    </span>
                    <div style={{ display: "flex", gap: 6 }}>
                      <button onClick={() => approveSub(s)}><i className="ti ti-check" aria-hidden="true" /> Approve</button>
                      <button onClick={() => rejectSub(s)}><i className="ti ti-x" aria-hidden="true" /> Reject</button>
                    </div>
                  </div>
                ))}
              </div>
            </div>
          )}

          <h3>Add entrant manually</h3>
          <div style={{ display: "flex", gap: 8, marginBottom: 8, flexWrap: "wrap" }}>
            <input placeholder="Viewer name" value={nameInput} onChange={(e) => setNameInput(e.target.value)} style={{ flex: "1 1 160px" }} />
            <input placeholder="Song — artist" value={songInput} onChange={(e) => setSongInput(e.target.value)} style={{ flex: "2 1 220px" }} />
            <button onClick={addEntrant}><i className="ti ti-plus" aria-hidden="true" /> Add</button>
          </div>
          {err && <p style={{ color: "var(--text-danger)", fontSize: 13 }}>{err}</p>}

          <h3 style={{ marginTop: 20 }}>Entrants ({t.entrants.length})</h3>
          {t.entrants.length === 0 && <p style={{ color: "var(--text-muted)", fontSize: 13 }}>No entrants yet.</p>}
          <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>
            {t.entrants.map((e) => (
              <div key={e.id} style={{ display: "flex", justifyContent: "space-between", alignItems: "center", background: "var(--surface-1)", padding: "8px 12px", borderRadius: 8 }}>
                <span style={{ fontSize: 13 }}>
                  <strong style={{ fontWeight: 500 }}>{e.name}</strong> — {e.song}
                </span>
                <button onClick={() => removeEntrant(e.id)} aria-label="Remove"><i className="ti ti-trash" aria-hidden="true" /></button>
              </div>
            ))}
          </div>

          <div style={{ marginTop: 24, display: "flex", gap: 8 }}>
            <button onClick={startTournament} style={{ borderColor: "var(--border-accent)", color: "var(--text-accent)" }}>
              <i className="ti ti-player-play" aria-hidden="true" /> {t.status === "setup" ? "Build bracket & start" : "Rebuild bracket"}
            </button>
            {t.status !== "setup" && (
              <button onClick={resetAll}><i className="ti ti-refresh" aria-hidden="true" /> Reset tournament</button>
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
                    Winner: {t.grandFinal.winner.name} — {t.grandFinal.winner.song}
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
          <BracketColumn title="Winners bracket" rounds={t.winners} anonymous editable={false} onPick={() => {}} labelPrefix="W" />
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

function SubmitView() {
  const [name, setName] = useState("");
  const [song, setSong] = useState("");
  const [sent, setSent] = useState(false);
  const [err, setErr] = useState("");

  const submit = async () => {
    if (!name.trim() || !song.trim()) {
      setErr("Enter both your name and your song");
      return;
    }
    setErr("");
    try {
      await addSubmission(name.trim(), song.trim());
      setSent(true);
    } catch (e) {
      setErr("Couldn't submit right now, try again in a moment");
    }
  };

  if (sent) {
    return (
      <div style={{ textAlign: "center", padding: "3rem 1rem" }}>
        <i className="ti ti-check" style={{ fontSize: 32, color: "var(--text-success)" }} aria-hidden="true" />
        <h2 style={{ marginTop: 12 }}>Submission sent</h2>
        <p style={{ color: "var(--text-secondary)" }}>The mods will review it before it's added to the bracket.</p>
        <button onClick={() => { setSent(false); setName(""); setSong(""); }} style={{ marginTop: 12 }}>Submit another</button>
      </div>
    );
  }

  return (
    <div style={{ maxWidth: 400, margin: "0 auto" }}>
      <h1>Submit your song</h1>
      <p style={{ fontSize: 13, color: "var(--text-secondary)" }}>Your identity stays hidden from other viewers until results are revealed.</p>
      <label style={{ display: "block", fontSize: 13, color: "var(--text-secondary)", marginTop: 16, marginBottom: 4 }}>Your name</label>
      <input value={name} onChange={(e) => setName(e.target.value)} style={{ width: "100%" }} placeholder="Twitch username" />
      <label style={{ display: "block", fontSize: 13, color: "var(--text-secondary)", marginTop: 12, marginBottom: 4 }}>Song</label>
      <input value={song} onChange={(e) => setSong(e.target.value)} style={{ width: "100%" }} placeholder="Song title — artist" />
      {err && <p style={{ color: "var(--text-danger)", fontSize: 13 }}>{err}</p>}
      <button onClick={submit} style={{ marginTop: 16, width: "100%", borderColor: "var(--border-accent)", color: "var(--text-accent)" }}>
        Submit
      </button>
    </div>
  );
}

export default function App() {
  const [view, setView] = useState("admin");

  return (
    <div style={{ padding: "1.5rem 1rem", maxWidth: 900, margin: "0 auto" }}>
      <div style={{ display: "flex", gap: 6, marginBottom: 24, flexWrap: "wrap" }}>
        {[
          ["admin", "Admin (mod only)"],
          ["public", "Public bracket"],
          ["overlay", "OBS overlay"],
          ["submit", "Submit song"],
        ].map(([k, label]) => (
          <button
            key={k}
            onClick={() => setView(k)}
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
      {view === "admin" && <AdminView />}
      {view === "public" && <PublicView />}
      {view === "overlay" && <OverlayView />}
      {view === "submit" && <SubmitView />}
    </div>
  );
}
