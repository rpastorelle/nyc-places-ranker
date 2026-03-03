import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * Dataset format (public/places.json):
 * [
 *   {
 *     "id": "optional-stable-id",
 *     "name": "",
 *     "borough": "",
 *     "neighborhood": "",
 *     "category": "",
 *     "visit_count": 0,
 *     "total_spend": 0,
 *     "avg_spend": 0,
 *     "first_visit": "",
 *     "last_visit": "",
 *
 *     // optional baseline ranking fields (used ONLY when no saved session matches)
 *     "rating": 1012,
 *     "wins": 1,
 *     "losses": 0,
 *     "comparisons": 1
 *   }
 * ]
 */

const DEFAULT_RATING = 1000;
const DEFAULT_K = 24;
const LS_KEY = "nyc_places_ranker_v8"; // bump for id + seed behavior

function slugify(str) {
  return String(str ?? "")
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/&/g, " and ")
    .replace(/[^\w\s-]/g, "")
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
    .trim();
}

function generateId(place) {
  // Used only if a row doesn't include an id.
  // NOTE: if you edit name/neighborhood/borough, the id does NOT change.
  return slugify(`${place.name}__${place.neighborhood}__${place.borough}`);
}

function expectedScore(rA, rB) {
  return 1 / (1 + Math.pow(10, (rB - rA) / 400));
}

function clamp(n, min, max) {
  return Math.max(min, Math.min(max, n));
}

function formatMoney(n) {
  if (typeof n !== "number" || Number.isNaN(n)) return "—";
  return n.toLocaleString(undefined, { style: "currency", currency: "USD" });
}

function safeParseJSON(value, fallback) {
  try {
    const parsed = JSON.parse(value);
    return parsed ?? fallback;
  } catch {
    return fallback;
  }
}

/**
 * Weighted item picker: prefer items with fewer comparisons.
 */
function pickWeighted(items, comparisonsById, disallowIds = new Set()) {
  const eligible = items.filter((p) => !disallowIds.has(p.id));
  if (eligible.length === 0) return null;

  const weights = eligible.map((p) => 1 / (1 + (comparisonsById[p.id] ?? 0)));
  const total = weights.reduce((a, b) => a + b, 0);

  let r = Math.random() * total;
  for (let i = 0; i < eligible.length; i++) {
    r -= weights[i];
    if (r <= 0) return eligible[i];
  }
  return eligible[eligible.length - 1];
}

/**
 * Choose a new pair, discouraging repeats.
 */
function choosePair(items, comparisonsById, pairCounts, lastPairKey) {
  if (items.length < 2) return null;

  for (let attempt = 0; attempt < 35; attempt++) {
    const a = pickWeighted(items, comparisonsById);
    if (!a) return null;

    const b = pickWeighted(items, comparisonsById, new Set([a.id]));
    if (!b) return null;

    const key = a.id < b.id ? `${a.id}__${b.id}` : `${b.id}__${a.id}`;
    if (key === lastPairKey) continue;

    const seen = pairCounts[key] ?? 0;
    const acceptChance = 1 / (1 + seen * 1.35);
    if (Math.random() < acceptChance) return { a, b, key };
  }

  // fallback
  const a = items[Math.floor(Math.random() * items.length)];
  let b = items[Math.floor(Math.random() * items.length)];
  while (b.id === a.id) b = items[Math.floor(Math.random() * items.length)];
  const key = a.id < b.id ? `${a.id}__${b.id}` : `${b.id}__${a.id}`;
  return { a, b, key };
}

function toNumberOrNull(v) {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) ? n : null;
}

export default function App() {
  const [places, setPlaces] = useState([]);
  const [loading, setLoading] = useState(true);

  // Ranking state (session)
  const [ratings, setRatings] = useState({});
  const [wins, setWins] = useState({});
  const [losses, setLosses] = useState({});
  const [comparisonsById, setComparisonsById] = useState({});
  const [pairCounts, setPairCounts] = useState({});
  const [history, setHistory] = useState([]);

  // Exclusions (removed places)
  const [excludedIds, setExcludedIds] = useState({}); // id -> true

  // Place edits (persisted): id -> { name, neighborhood, category, borough }
  const [placeEditsById, setPlaceEditsById] = useState({});

  // Baseline seeds captured from places.json (used when no session matches)
  const [baselineSeed, setBaselineSeed] = useState({
    ratings: {},
    wins: {},
    losses: {},
    comparisonsById: {}
  });

  // UX
  const [kFactor, setKFactor] = useState(DEFAULT_K);
  const [showLeaderboard, setShowLeaderboard] = useState(false);
  const [currentPair, setCurrentPair] = useState(null);

  // Leaderboard filter
  const [leaderboardNeighborhood, setLeaderboardNeighborhood] = useState("ALL");

  // Edit modal state
  const [editingId, setEditingId] = useState(null);
  const [editDraft, setEditDraft] = useState({
    name: "",
    neighborhood: "",
    category: "",
    borough: ""
  });

  const lastPairKeyRef = useRef(null);

  function applyEdits(place, edits) {
    if (!edits) return place;
    return {
      ...place,
      name: typeof edits.name === "string" ? edits.name : place.name,
      neighborhood:
        typeof edits.neighborhood === "string" ? edits.neighborhood : place.neighborhood,
      category: typeof edits.category === "string" ? edits.category : place.category,
      borough: typeof edits.borough === "string" ? edits.borough : place.borough
    };
  }

  // Load dataset + restore session OR seed from file
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);

      const res = await fetch("/places.json", { cache: "no-store" });
      const raw = await res.json();
      if (cancelled) return;

      const basePlaces = (Array.isArray(raw) ? raw : [])
        .filter((p) => p && p.name)
        .map((p) => {
          const base = {
            name: String(p.name ?? ""),
            borough: String(p.borough ?? "—"),
            neighborhood: String(p.neighborhood ?? "—"),
            category: String(p.category ?? ""),
            visit_count:
              typeof p.visit_count === "number" ? p.visit_count : Number(p.visit_count) || 0,
            total_spend:
              typeof p.total_spend === "number" ? p.total_spend : Number(p.total_spend) || 0,
            avg_spend: typeof p.avg_spend === "number" ? p.avg_spend : Number(p.avg_spend) || 0,
            first_visit: p.first_visit ? String(p.first_visit) : "",
            last_visit: p.last_visit ? String(p.last_visit) : ""
          };

          const id = p.id ? String(p.id) : generateId(base);

          // baseline seed fields (optional)
          const seedRating = toNumberOrNull(p.rating);
          const seedWins = toNumberOrNull(p.wins);
          const seedLosses = toNumberOrNull(p.losses);
          const seedComps = toNumberOrNull(p.comparisons);

          return {
            ...base,
            id,
            _seed: {
              rating: seedRating,
              wins: seedWins,
              losses: seedLosses,
              comparisons: seedComps
            }
          };
        });

      // Compute dataset hash from ids
      const datasetHash = basePlaces.map((p) => p.id).sort().join("|");

      // Build baseline seeds from file (for fallback usage)
      const fileSeed = {
        ratings: {},
        wins: {},
        losses: {},
        comparisonsById: {}
      };

      for (const p of basePlaces) {
        fileSeed.ratings[p.id] =
          typeof p._seed.rating === "number" ? p._seed.rating : DEFAULT_RATING;

        fileSeed.wins[p.id] = typeof p._seed.wins === "number" ? Math.max(0, p._seed.wins) : 0;
        fileSeed.losses[p.id] =
          typeof p._seed.losses === "number" ? Math.max(0, p._seed.losses) : 0;

        if (typeof p._seed.comparisons === "number") {
          fileSeed.comparisonsById[p.id] = Math.max(0, p._seed.comparisons);
        } else {
          // sensible fallback if comparisons missing
          fileSeed.comparisonsById[p.id] = (fileSeed.wins[p.id] ?? 0) + (fileSeed.losses[p.id] ?? 0);
        }
      }

      setBaselineSeed(fileSeed);

      // Attempt restore from localStorage ONLY if datasetHash matches
      const saved = safeParseJSON(localStorage.getItem(LS_KEY), null);

      let nextEdits = {};
      let restored = false;

      if (saved && saved.datasetHash && saved.datasetHash === datasetHash) {
        setRatings(saved.ratings || {});
        setWins(saved.wins || {});
        setLosses(saved.losses || {});
        setComparisonsById(saved.comparisonsById || {});
        setPairCounts(saved.pairCounts || {});
        setHistory(saved.history || []);
        setExcludedIds(saved.excludedIds || {});
        setKFactor(saved.kFactor ?? DEFAULT_K);
        setShowLeaderboard(saved.showLeaderboard ?? false);
        setLeaderboardNeighborhood(saved.leaderboardNeighborhood ?? "ALL");

        nextEdits = saved.placeEditsById || {};
        setPlaceEditsById(nextEdits);

        restored = true;
      } else {
        // No matching saved session → seed from file
        setRatings(fileSeed.ratings);
        setWins(fileSeed.wins);
        setLosses(fileSeed.losses);
        setComparisonsById(fileSeed.comparisonsById);

        setPairCounts({});
        setHistory([]);
        setExcludedIds({});
        setKFactor(DEFAULT_K);
        setShowLeaderboard(false);
        setLeaderboardNeighborhood("ALL");
        setPlaceEditsById({});
        restored = false;
      }

      // Apply edits (if restored)
      const placesWithEdits = basePlaces.map((p) => {
        const withoutSeed = { ...p };
        delete withoutSeed._seed;
        return applyEdits(withoutSeed, nextEdits[p.id]);
      });

      setPlaces(placesWithEdits);

      // If we restored a session, keep the currentPair null so it can regenerate.
      // If we seeded fresh, also keep currentPair null.
      setCurrentPair(null);
      lastPairKeyRef.current = null;

      if (!cancelled) setLoading(false);
    }

    load();
    return () => {
      cancelled = true;
    };
  }, []);

  // Active pool
  const activePlaces = useMemo(
    () => places.filter((p) => !excludedIds[p.id]),
    [places, excludedIds]
  );

  // Keep hooks above conditional returns
  const editingPlace = useMemo(() => {
    if (!editingId) return null;
    return places.find((p) => p.id === editingId) ?? null;
  }, [editingId, places]);

  // Persist state
  useEffect(() => {
    if (!places.length) return;

    const datasetHash = places.map((p) => p.id).sort().join("|");

    localStorage.setItem(
      LS_KEY,
      JSON.stringify({
        datasetHash,
        ratings,
        wins,
        losses,
        comparisonsById,
        pairCounts,
        history: history.slice(0, 300),
        excludedIds,
        kFactor,
        showLeaderboard,
        leaderboardNeighborhood,
        placeEditsById
      })
    );
  }, [
    places,
    ratings,
    wins,
    losses,
    comparisonsById,
    pairCounts,
    history,
    excludedIds,
    kFactor,
    showLeaderboard,
    leaderboardNeighborhood,
    placeEditsById
  ]);

  // Generate a pair whenever currentPair is cleared
  useEffect(() => {
    if (loading) return;
    if (currentPair) return;
    if (activePlaces.length < 2) return;
    if (editingId) return;

    const pair = choosePair(activePlaces, comparisonsById, pairCounts, lastPairKeyRef.current);
    if (pair) {
      lastPairKeyRef.current = pair.key;
      setCurrentPair(pair);
    }
  }, [loading, currentPair, activePlaces, comparisonsById, pairCounts, editingId]);

  // Neighborhood list for filtering leaderboard
  const neighborhoodOptions = useMemo(() => {
    const s = new Set();
    for (const p of activePlaces) {
      const n = String(p.neighborhood ?? "").trim();
      if (n) s.add(n);
    }
    return ["ALL", ...Array.from(s).sort((a, b) => a.localeCompare(b))];
  }, [activePlaces]);

  // Leaderboard for active pool (optionally filtered)
  const leaderboard = useMemo(() => {
    const filtered =
      leaderboardNeighborhood === "ALL"
        ? activePlaces
        : activePlaces.filter((p) => p.neighborhood === leaderboardNeighborhood);

    const rows = filtered.map((p) => {
      const r = ratings[p.id] ?? DEFAULT_RATING;
      const w = wins[p.id] ?? 0;
      const l = losses[p.id] ?? 0;
      const c = comparisonsById[p.id] ?? 0;
      return { ...p, rating: r, wins: w, losses: l, comparisons: c };
    });

    rows.sort((a, b) => b.rating - a.rating);
    return rows.map((row, i) => ({ ...row, rank: i + 1 }));
  }, [activePlaces, ratings, wins, losses, comparisonsById, leaderboardNeighborhood]);

  const totalComparisons = history.length;

  function recordResult(winnerId, loserId) {
    setRatings((prev) => {
      const rW = prev[winnerId] ?? DEFAULT_RATING;
      const rL = prev[loserId] ?? DEFAULT_RATING;

      const eW = expectedScore(rW, rL);
      const eL = expectedScore(rL, rW);

      const k = clamp(kFactor, 8, 64);

      return {
        ...prev,
        [winnerId]: rW + k * (1 - eW),
        [loserId]: rL + k * (0 - eL)
      };
    });

    setWins((prev) => ({ ...prev, [winnerId]: (prev[winnerId] ?? 0) + 1 }));
    setLosses((prev) => ({ ...prev, [loserId]: (prev[loserId] ?? 0) + 1 }));

    setComparisonsById((prev) => ({
      ...prev,
      [winnerId]: (prev[winnerId] ?? 0) + 1,
      [loserId]: (prev[loserId] ?? 0) + 1
    }));

    const key = winnerId < loserId ? `${winnerId}__${loserId}` : `${loserId}__${winnerId}`;
    setPairCounts((prev) => ({ ...prev, [key]: (prev[key] ?? 0) + 1 }));

    setHistory((prev) =>
      [{ ts: new Date().toISOString(), winnerId, loserId }, ...prev].slice(0, 300)
    );

    setCurrentPair(null);
  }

  function chooseLeft() {
    if (!currentPair) return;
    recordResult(currentPair.a.id, currentPair.b.id);
  }

  function chooseRight() {
    if (!currentPair) return;
    recordResult(currentPair.b.id, currentPair.a.id);
  }

  // Skip replaces the entire matchup (no Elo change, no exclusions)
  function skipMatchup() {
    setCurrentPair(null);
  }

  /**
   * Remove ONE card:
   * - Excludes that place from future matchups
   * - Keeps the other card in place
   * - Replaces ONLY the removed side with a new opponent
   */
  function excludeOneAndReplace(removedId) {
    if (!currentPair) return;

    const kept = currentPair.a.id === removedId ? currentPair.b : currentPair.a;

    // Exclude removed
    setExcludedIds((prev) => ({ ...prev, [removedId]: true }));

    // Compute a pool that reflects immediate removal (and does not include kept)
    const nextPool = activePlaces.filter((p) => p.id !== removedId && p.id !== kept.id);
    if (nextPool.length === 0) {
      setCurrentPair(null);
      return;
    }

    // Pick a new opponent (prefer fewer comparisons)
    const opponent = pickWeighted(nextPool, comparisonsById);
    if (!opponent) {
      setCurrentPair(null);
      return;
    }

    // Preserve which side the kept card was on
    const newPair =
      currentPair.a.id === kept.id
        ? {
            a: kept,
            b: opponent,
            key: kept.id < opponent.id ? `${kept.id}__${opponent.id}` : `${opponent.id}__${kept.id}`
          }
        : {
            a: opponent,
            b: kept,
            key: kept.id < opponent.id ? `${kept.id}__${opponent.id}` : `${opponent.id}__${kept.id}`
          };

    lastPairKeyRef.current = newPair.key;
    setCurrentPair(newPair);
  }

  function undoExcludeAll() {
    const ok = confirm("Un-exclude all places? They will reappear in matchups.");
    if (!ok) return;
    setExcludedIds({});
    setCurrentPair(null);
  }

  function resetAll() {
    const ok = confirm("Reset rankings, history, exclusions, and edits? This clears local progress.");
    if (!ok) return;

    localStorage.removeItem(LS_KEY);

    // Full reset to defaults (NOT seeded)
    setRatings({});
    setWins({});
    setLosses({});
    setComparisonsById({});
    setPairCounts({});
    setHistory([]);
    setExcludedIds({});
    setPlaceEditsById({});
    setLeaderboardNeighborhood("ALL");
    setEditingId(null);
    setCurrentPair(null);
    lastPairKeyRef.current = null;
  }

  function exportRankedJSON() {
    // Export uses ALL active places (not the filtered leaderboard view),
    // includes edits (already applied in `places`), and includes id
    const exportRows = activePlaces
      .map((p) => {
        const r = ratings[p.id] ?? DEFAULT_RATING;
        const w = wins[p.id] ?? 0;
        const l = losses[p.id] ?? 0;
        const c = comparisonsById[p.id] ?? 0;
        return { ...p, rating: r, wins: w, losses: l, comparisons: c };
      })
      .sort((a, b) => (b.rating ?? 0) - (a.rating ?? 0))
      .map((p, i) => ({
        id: p.id,

        name: p.name,
        borough: p.borough,
        neighborhood: p.neighborhood,
        category: p.category,
        visit_count: p.visit_count,
        total_spend: p.total_spend,
        avg_spend: p.avg_spend,
        first_visit: p.first_visit,
        last_visit: p.last_visit,

        // optional baseline fields for drop-in replacement seeding
        rank: i + 1,
        rating: Math.round(p.rating ?? DEFAULT_RATING),
        wins: p.wins ?? 0,
        losses: p.losses ?? 0,
        comparisons: p.comparisons ?? 0
      }));

    const blob = new Blob([JSON.stringify(exportRows, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "ranked_places.json";
    a.click();
    URL.revokeObjectURL(url);
  }

  // --- Editing ---
  function openEdit(place) {
    if (!place) return;
    setEditingId(place.id);
    setEditDraft({
      name: String(place.name ?? ""),
      neighborhood: String(place.neighborhood ?? ""),
      category: String(place.category ?? ""),
      borough: String(place.borough ?? "")
    });
  }

  function closeEdit() {
    setEditingId(null);
  }

  function saveEdit() {
    const id = editingId;
    if (!id) return;

    const next = {
      name: String(editDraft.name ?? "").trim(),
      neighborhood: String(editDraft.neighborhood ?? "").trim(),
      category: String(editDraft.category ?? "").trim(),
      borough: String(editDraft.borough ?? "").trim()
    };

    if (!next.name) {
      alert("Name is required.");
      return;
    }
    if (!next.borough) {
      alert("Borough is required.");
      return;
    }

    // Persist edits by id
    setPlaceEditsById((prev) => ({ ...prev, [id]: next }));

    // Update visible places immediately (id stays the same)
    setPlaces((prev) => prev.map((p) => (p.id === id ? { ...p, ...next } : p)));

    // If currently shown pair includes this place, update the pair objects too
    setCurrentPair((prev) => {
      if (!prev) return prev;
      const a = prev.a?.id === id ? { ...prev.a, ...next } : prev.a;
      const b = prev.b?.id === id ? { ...prev.b, ...next } : prev.b;
      return { ...prev, a, b };
    });

    setEditingId(null);
  }

  // Keyboard controls (disabled while modal open)
  useEffect(() => {
    function onKeyDown(e) {
      if (loading) return;

      if (editingId) {
        if (e.key === "Escape") {
          e.preventDefault();
          closeEdit();
        }
        return;
      }

      if (!currentPair) return;

      if (e.key === "ArrowLeft") {
        e.preventDefault();
        chooseLeft();
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        chooseRight();
      } else if (e.key.toLowerCase() === "s") {
        e.preventDefault();
        skipMatchup();
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading, currentPair, kFactor, editingId]);

  if (loading) {
    return (
      <div className="container">
        <div className="header">
          <div className="brand">
            <h1>NYC Places Ranker</h1>
            <div className="sub">Loading dataset…</div>
          </div>
        </div>
      </div>
    );
  }

  if (activePlaces.length < 2) {
    return (
      <div className="container">
        <div className="header">
          <div className="brand">
            <h1>NYC Places Ranker</h1>
            <div className="sub">
              You need at least 2 active places. Excluded:{" "}
              <strong>{Object.keys(excludedIds).length}</strong>
            </div>
            <div style={{ marginTop: 10, display: "flex", gap: 10, flexWrap: "wrap" }}>
              <button onClick={undoExcludeAll}>Un-exclude all</button>
              <button onClick={resetAll}>Reset everything</button>
            </div>
          </div>
        </div>
      </div>
    );
  }

  const left = currentPair?.a;
  const right = currentPair?.b;

  return (
    <div className="container">
      <header className="header">
        <div className="brand">
          <h1>NYC Places Ranker</h1>
          <div className="sub">
            Choose with <kbd>←</kbd>/<kbd>→</kbd>, or skip with <kbd>S</kbd>.
          </div>
        </div>

        <div className="controls">
          <label className="kControl">
            K-Factor
            <input
              type="number"
              value={kFactor}
              min={8}
              max={64}
              onChange={(e) => setKFactor(Number(e.target.value))}
            />
          </label>

          <button onClick={() => setShowLeaderboard((s) => !s)}>
            {showLeaderboard ? "Hide" : "Show"} leaderboard
          </button>

          <button onClick={exportRankedJSON}>Export ranked JSON</button>
          <button onClick={undoExcludeAll}>Un-exclude all</button>
          <button className="danger" onClick={resetAll}>
            Reset
          </button>
        </div>
      </header>

      <div className="statsRow">
        <div className="pill">Active places: {activePlaces.length}</div>
        <div className="pill">Excluded: {Object.keys(excludedIds).length}</div>
        <div className="pill">Comparisons: {totalComparisons}</div>
      </div>

      <main className="main">
        <section className="arena">
          <div className="cards">
            <PlaceCard
              side="left"
              place={left}
              rating={left ? ratings[left.id] : null}
              wins={left ? wins[left.id] : 0}
              losses={left ? losses[left.id] : 0}
              onChoose={chooseLeft}
              onExclude={excludeOneAndReplace}
              onEdit={openEdit}
              hotkey="←"
            />

            {/* Center, visible skip button */}
            <button className="centerSkip" type="button" onClick={skipMatchup}>
              <div className="centerSkipInner">
                <div className="skipLabel">SKIP</div>
                <div className="skipHint">Press S</div>
              </div>
            </button>

            <PlaceCard
              side="right"
              place={right}
              rating={right ? ratings[right.id] : null}
              wins={right ? wins[right.id] : 0}
              losses={right ? losses[right.id] : 0}
              onChoose={chooseRight}
              onExclude={excludeOneAndReplace}
              onEdit={openEdit}
              hotkey="→"
            />
          </div>
        </section>

        {showLeaderboard && (
          <section className="leaderboard">
            <div className="leaderboardHeader">
              <h2>Leaderboard</h2>

              <div className="leaderboardFilters">
                <label className="filterLabel">
                  Neighborhood
                  <select
                    value={leaderboardNeighborhood}
                    onChange={(e) => setLeaderboardNeighborhood(e.target.value)}
                  >
                    {neighborhoodOptions.map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>

                {leaderboardNeighborhood !== "ALL" ? (
                  <button
                    type="button"
                    className="filterClear"
                    onClick={() => setLeaderboardNeighborhood("ALL")}
                  >
                    Clear
                  </button>
                ) : null}
              </div>
            </div>

            <div className="table">
              <div className="thead">
                <div>#</div>
                <div>Place</div>
                <div>Neighborhood</div>
                <div className="num">Rating</div>
                <div className="num">W-L</div>
                <div className="num">Comps</div>
                <div className="num">Visits</div>
                <div className="num">Spend</div>
              </div>

              {leaderboard.slice(0, 75).map((p) => (
                <div className="trow" key={p.id}>
                  <div>{p.rank}</div>
                  <div className="placeName">{p.name}</div>
                  <div>{p.neighborhood}</div>
                  <div className="num">{Math.round(p.rating)}</div>
                  <div className="num">
                    {p.wins}-{p.losses}
                  </div>
                  <div className="num">{p.comparisons}</div>
                  <div className="num">{p.visit_count}</div>
                  <div className="num">{formatMoney(p.total_spend)}</div>
                </div>
              ))}
            </div>
          </section>
        )}
      </main>

      {/* Edit modal */}
      {editingId && (
        <EditPlaceModal
          place={editingPlace}
          draft={editDraft}
          setDraft={setEditDraft}
          onClose={closeEdit}
          onSave={saveEdit}
        />
      )}
    </div>
  );
}

function PlaceCard({ side, place, rating, wins, losses, onChoose, onExclude, onEdit, hotkey }) {
  if (!place) {
    return (
      <div className={`card ${side}`} aria-disabled="true">
        <div className="cardTitle">Loading…</div>
      </div>
    );
  }

  return (
    <div
      className={`card ${side}`}
      role="button"
      tabIndex={0}
      onClick={onChoose}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onChoose?.();
        }
      }}
    >
      <div className="cardHotkey">{hotkey}</div>

      {/* Remove */}
      <button
        type="button"
        className="cardRemove"
        title="Remove this place from matchups"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onExclude?.(place.id);
        }}
      >
        ✕
      </button>

      {/* Edit */}
      <button
        type="button"
        className="cardEdit"
        title="Edit place info"
        onClick={(e) => {
          e.preventDefault();
          e.stopPropagation();
          onEdit?.(place);
        }}
      >
        ✎
      </button>

      <div className="cardTitle">{place.name}</div>

      <div className="tags">
        <span className="tag accent">{place.neighborhood || "—"}</span>
        <span className="tag">{place.borough || "—"}</span>
        {place.category ? <span className="tag green">{place.category}</span> : null}
      </div>

      <div className="cardDetails">
        <div>
          <div className="label">Visits</div>
          <div className="value">{place.visit_count ?? 0}</div>
        </div>
        <div>
          <div className="label">Spend</div>
          <div className="value">{formatMoney(place.total_spend ?? 0)}</div>
        </div>
        <div>
          <div className="label">Elo</div>
          <div className="value">{Math.round(rating ?? DEFAULT_RATING)}</div>
        </div>

        <div>
          <div className="label">First</div>
          <div className="value">{place.first_visit || "—"}</div>
        </div>
        <div>
          <div className="label">Last</div>
          <div className="value">{place.last_visit || "—"}</div>
        </div>
        <div>
          <div className="label">W–L</div>
          <div className="value">
            {(wins ?? 0)}–{(losses ?? 0)}
          </div>
        </div>
      </div>
    </div>
  );
}

function EditPlaceModal({ place, draft, setDraft, onClose, onSave }) {
  return (
    <div
      className="modalOverlay"
      role="dialog"
      aria-modal="true"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose?.();
      }}
    >
      <div className="modal" onMouseDown={(e) => e.stopPropagation()}>
        <div className="modalHeader">
          <div>
            <div className="modalTitle">Edit place</div>
            <div className="modalSub">id: {place?.id || "—"}</div>
          </div>

          <button className="modalClose" type="button" onClick={onClose} aria-label="Close">
            ✕
          </button>
        </div>

        <div className="modalBody">
          <label className="field">
            <div className="fieldLabel">Name</div>
            <input
              value={draft.name}
              onChange={(e) => setDraft((d) => ({ ...d, name: e.target.value }))}
              autoFocus
              placeholder="Place name"
            />
          </label>

          <div className="fieldRow">
            <label className="field">
              <div className="fieldLabel">Neighborhood</div>
              <input
                value={draft.neighborhood}
                onChange={(e) => setDraft((d) => ({ ...d, neighborhood: e.target.value }))}
                placeholder="e.g. Williamsburg"
              />
            </label>

            <label className="field">
              <div className="fieldLabel">Borough</div>
              <input
                value={draft.borough}
                onChange={(e) => setDraft((d) => ({ ...d, borough: e.target.value }))}
                placeholder="e.g. Brooklyn"
              />
            </label>
          </div>

          <label className="field">
            <div className="fieldLabel">Category</div>
            <input
              value={draft.category}
              onChange={(e) => setDraft((d) => ({ ...d, category: e.target.value }))}
              placeholder="e.g. Restaurant"
            />
          </label>

          <div className="modalNote">
            Saves locally (localStorage). Export will include these edited fields.
          </div>
        </div>

        <div className="modalFooter">
          <button type="button" className="modalBtn" onClick={onClose}>
            Cancel
          </button>
          <button type="button" className="modalBtn primary" onClick={onSave}>
            Save changes
          </button>
        </div>
      </div>
    </div>
  );
}
