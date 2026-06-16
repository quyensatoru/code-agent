// Stopping pressure for open-ended investigation. The agent must not grep/read
// forever: after `limit` consecutive exploration tool calls without an edit, a
// run, or a recorded hypothesis, the loop injects a one-time system nudge to
// converge, re-firing every `limit` further calls. Soft pressure only —
// maxTurns stays the hard ceiling.

export function searchBudgetNudge(streak, lastWarnAt, limit) {
    if (!limit || streak < limit || streak - lastWarnAt < limit) return null;
    return {
        warnAt: streak,
        message:
            `You have run ${streak} consecutive search/read calls without making a change, ` +
            'running anything, or recording a hypothesis. Stop open-ended searching: use ' +
            'Hypothesize to commit to your best 1-3 root causes, confirm the most likely one ' +
            'with a single targeted check (Grep/TraceCalls/Read/RunCode), then act. If blocked, ' +
            'state what evidence is missing instead of searching more.',
    };
}
