# 🗽 NYC Places Ranker

A pairwise, Elo-powered ranking engine for your real-life NYC history.

This app helps you turn messy transaction data into a **clean, personal, evolving ranking of your favorite places** — restaurants, bars, coffee shops, venues, anything.

Instead of trying to manually sort 200+ places, you simply answer:

> This… or that?

Over time, a mathematically stable ranking emerges.

---

## ✨ What This App Does

* Loads a structured `places.json` dataset
* Presents two places side-by-side
* Lets you choose:

  * ← Left
  * → Right
  * Skip
  * ✕ Remove a place entirely
* Uses **Elo rating (like chess)** to update rankings
* Persists everything locally in `localStorage`
* Generates a ranked JSON export

You don’t manually drag or sort.
You just react instinctively.

---

## 🧠 Why Pairwise + Elo?

Sorting large lists is cognitively exhausting.

Pairwise comparison:

* Feels intuitive
* Avoids overthinking
* Handles uncertainty gracefully
* Scales to large datasets

Elo:

* Updates ratings dynamically
* Adapts over time
* Doesn’t require full comparisons between all pairs
* Stabilizes naturally

You don’t need to compare everything to everything.

The system learns.

---

## 📂 Dataset Format

Create a file at:

```
public/places.json
```

Format:

```json
[
  {
    "name": "L’Industrie Pizzeria",
    "borough": "Brooklyn",
    "neighborhood": "Williamsburg",
    "category": "Restaurant",
    "visit_count": 6,
    "total_spend": 184.32,
    "avg_spend": 30.72,
    "first_visit": "2022-05-12",
    "last_visit": "2024-01-08"
  }
]
```

### Required

* `name`

### Recommended

* borough
* neighborhood
* visit_count
* total_spend

IDs are automatically generated from:

```
name + neighborhood + borough
```

---

## 🎮 How To Use

### Choose

* ← = choose left
* → = choose right
* Click either card

### Skip

* Click the center “SKIP” button
* Or press `S`

Skips do not affect ratings.

### Remove

* Click ✕ on a card

Removes that place from:

* Future matchups
* Leaderboard

It does NOT change Elo.

### Reset

* Clears:

  * Ratings
  * History
  * Exclusions

Everything is stored in your browser’s localStorage.

---

## 📊 Understanding K-Factor

K determines how dramatic rating changes are.

* Low K (8–16) → slow, stable
* Medium K (24) → balanced
* High K (40+) → volatile, reactive

Recommended:

* Start at 24
* Drop to 16 once rankings stabilize

---

## 🚀 Getting Started

### 1. Install

```bash
npm install
```

### 2. Run

```bash
npm run dev
```

### 3. Add your dataset

Edit:

```
public/places.json
```

---

## 🛠 How To Modify

### Change Rating Behavior

Look for:

```js
const DEFAULT_K = 24;
```

Or inside:

```js
recordResult()
```

You can implement:

* Adaptive K (lower K for high-comparison places)
* Recency weighting
* Visit_count-based initial seeding

---

### Modify Pair Selection Logic

Look for:

```js
choosePair()
pickWeighted()
```

Currently:

* Favors places with fewer comparisons
* Avoids repeating recent pairs

You could:

* Bias toward similar rating ranges
* Force category matchups
* Add “refinement mode”

---

### Add Filters

To add category filtering:

Modify:

```js
const activePlaces = ...
```

Add:

```js
p.category === selectedCategory
```

---

### Add Undo

Track last action in state and reverse:

* Rating change
* Comparison counts
* Exclusion

---

## 🎨 Design Inspiration

This app leans into:

* 1990s NYC zine / flyer / subway energy
* Tactile, physical decision-making
* Imperfect but expressive UI
* Human-first ranking over spreadsheet logic

It feels like:

* Taping flyers to a subway wall
* Crossing things out with a marker
* Deciding where you’d rather go tonight

Not corporate.
Not sterile.
Personal.

---

## 🎯 Goals

This isn’t just about ranking restaurants.

It’s about:

* Discovering patterns in your behavior
* Surfacing subconscious preferences
* Creating a living artifact of your time in NYC
* Turning transaction history into identity

Your spending history becomes:

> A map of your taste.

---

## 📤 Export

Click:

```
Export ranked JSON
```

You’ll get a file that preserves original fields and adds:

```json
{
  "rank": 1,
  "rating": 1324,
  "wins": 17,
  "losses": 3,
  "comparisons": 20
}
```

---

## 🔮 Future Ideas

* Allow user to edit the name
* Allow user to merge multiple places into one
* Soft-remove instead of permanent exclusion
* Category-only ranking mode (pizza-only tournament)
* “Top 30 Confirmation” flow
* Timeline heatmaps
* Neighborhood bias analysis
* Date-night vs solo-mode ranking
* Adaptive K based on rating volatility
* Confidence score per ranking

---

## 🧩 Philosophy

This app assumes:

* Preferences are contextual.
* You don’t know your true ranking upfront.
* Decisions are easier than global judgments.
* Taste evolves.

It doesn’t ask:

> “What’s your #1 restaurant?”

It asks:

> “Right now… which one wins?”

Over and over.

And from that,
your city organizes itself.


---

# React + Vite

This template provides a minimal setup to get React working in Vite with HMR and some ESLint rules.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) (or [oxc](https://oxc.rs) when used in [rolldown-vite](https://vite.dev/guide/rolldown)) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## React Compiler

The React Compiler is not enabled on this template because of its impact on dev & build performances. To add it, see [this documentation](https://react.dev/learn/react-compiler/installation).

## Expanding the ESLint configuration

If you are developing a production application, we recommend using TypeScript with type-aware lint rules enabled. Check out the [TS template](https://github.com/vitejs/vite/tree/main/packages/create-vite/template-react-ts) for information on how to integrate TypeScript and [`typescript-eslint`](https://typescript-eslint.io) in your project.
