export function summarize(samples) {
  const durations = samples
    .filter((sample) => sample.status === "ok" && Number.isFinite(sample.durationMs))
    .map((sample) => sample.durationMs)
    .sort((left, right) => left - right);
  const errors = samples.length - durations.length;
  if (durations.length === 0) {
    return {
      count: samples.length,
      successCount: 0,
      errorCount: errors,
      successRate: 0,
      min: null,
      max: null,
      mean: null,
      stddev: null,
      cv: null,
      p50: null,
      p90: null,
      p95: null,
      p99: null,
    };
  }

  const mean = durations.reduce((total, value) => total + value, 0) / durations.length;
  const variance = durations.reduce((total, value) => total + ((value - mean) ** 2), 0) / durations.length;
  const stddev = Math.sqrt(variance);
  return {
    count: samples.length,
    successCount: durations.length,
    errorCount: errors,
    successRate: durations.length / samples.length,
    min: durations[0],
    max: durations.at(-1),
    mean,
    stddev,
    cv: mean === 0 ? 0 : stddev / mean,
    p50: percentile(durations, 0.5),
    p90: percentile(durations, 0.9),
    p95: percentile(durations, 0.95),
    p99: percentile(durations, 0.99),
  };
}

export function groupSamples(samples) {
  const groups = new Map();
  for (const sample of samples) {
    const key = [
      sample.route,
      sample.tool,
      sample.scenario,
      sample.cold ? "cold" : "warm",
      sample.concurrency,
    ].join("|");
    const group = groups.get(key) ?? [];
    group.push(sample);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, entries]) => {
    const [route, tool, scenario, temperature, concurrency] = key.split("|");
    return {
      route,
      tool,
      scenario,
      cold: temperature === "cold",
      concurrency: Number(concurrency),
      ...summarize(entries),
    };
  });
}

function percentile(sortedValues, quantile) {
  if (sortedValues.length === 1) {
    return sortedValues[0];
  }
  const position = (sortedValues.length - 1) * quantile;
  const lowerIndex = Math.floor(position);
  const upperIndex = Math.ceil(position);
  const lower = sortedValues[lowerIndex];
  const upper = sortedValues[upperIndex];
  if (lowerIndex === upperIndex) {
    return lower;
  }
  return lower + ((upper - lower) * (position - lowerIndex));
}
