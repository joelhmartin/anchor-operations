/**
 * Cost tracker for ops run execution — Phase 2.
 *
 * Each check handler is invoked as `handler(ctx, costTracker)` and may call
 * `costTracker.add({ tokens, dollars, source })` to accrue cost. The executor
 * aggregates a per-check + total summary into `ops_runs.token_usage_json` and
 * computes `cost_estimate_cents` from the running total.
 *
 * Cost is accumulated in floating dollars internally; `totalCents()` rounds up
 * (Math.ceil) so partial cents always trip the tier budget cap.
 */

export function createCostTracker() {
  const entries = [];
  let totalDollars = 0;
  let totalTokens = 0;
  let totalCompletionTokens = 0;
  let totalPromptTokens = 0;

  function add({ tokens, promptTokens, completionTokens, dollars, source } = {}) {
    const dollarsNum = Number(dollars) || 0;
    const tokensNum = Number(tokens) || 0;
    const promptNum = Number(promptTokens) || 0;
    const completionNum = Number(completionTokens) || 0;

    totalDollars += dollarsNum;
    totalTokens += tokensNum;
    totalPromptTokens += promptNum;
    totalCompletionTokens += completionNum;

    entries.push({
      source: source || 'unknown',
      dollars: dollarsNum,
      tokens: tokensNum,
      prompt_tokens: promptNum,
      completion_tokens: completionNum,
      at: new Date().toISOString()
    });
  }

  function totalCents() {
    return Math.ceil(totalDollars * 100);
  }

  function summary() {
    return {
      total_dollars: Number(totalDollars.toFixed(6)),
      total_cents: totalCents(),
      total_tokens: totalTokens,
      prompt_tokens: totalPromptTokens,
      completion_tokens: totalCompletionTokens,
      entries: entries.slice()
    };
  }

  function reset() {
    entries.length = 0;
    totalDollars = 0;
    totalTokens = 0;
    totalPromptTokens = 0;
    totalCompletionTokens = 0;
  }

  return { add, totalCents, summary, reset };
}
