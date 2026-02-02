function qs(name) {
  const u = new URL(window.location.href);
  return u.searchParams.get(name);
}

function getOrCreateVoterId() {
  const key = "starcup_voter_id";
  let v = localStorage.getItem(key);
  if (!v) {
    v = "v_" + Math.random().toString(16).slice(2) + Date.now().toString(16);
    localStorage.setItem(key, v);
  }
  return v;
}

function blurActiveSoon() {
  setTimeout(() => {
    try { document.activeElement && document.activeElement.blur(); } catch(_) {}
  }, 0);
}

function sumVotes(votesObj) {
  let s = 0;
  for (const k in (votesObj || {})) s += (votesObj[k] || 0);
  return s;
}

function leaderId(suggestions, votesObj) {
  let bestId = null;
  let best = -1;
  for (const t of (suggestions || [])) {
    const c = (votesObj && votesObj[t.id]) ? votesObj[t.id] : 0;
    if (c > best) { best = c; bestId = t.id; }
  }
  return bestId;
}
