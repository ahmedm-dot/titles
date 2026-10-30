// A/B arms = model × reasoning × prompt. `DEFAULT_ARM` is the benchmark winner (see README / bench/results).
export const ARMS = {
  // --- latency-first small models ---
  'nano54-fewshot':   { model: 'gpt-5.4-nano', reasoning_effort: 'none', prompt: 'fewshot' },
  'nano54-rules':     { model: 'gpt-5.4-nano', reasoning_effort: 'none', prompt: 'rules' },
  'mini54-minimal':   { model: 'gpt-5.4-mini', reasoning_effort: 'none', prompt: 'minimal' },
  'mini54-rules':     { model: 'gpt-5.4-mini', reasoning_effort: 'none', prompt: 'rules' },
  'mini54-fewshot':   { model: 'gpt-5.4-mini', reasoning_effort: 'none', prompt: 'fewshot' },
  'mini54-low':       { model: 'gpt-5.4-mini', reasoning_effort: 'low',  prompt: 'fewshot' },
  'mini41-fewshot':   { model: 'gpt-4.1-mini', prompt: 'fewshot' },
  '4omini-fewshot':   { model: 'gpt-4o-mini',  prompt: 'fewshot' },
  // --- round 2: prompt v2 + priority processing ---
  'nano54-fs2':       { model: 'gpt-5.4-nano', reasoning_effort: 'none', prompt: 'fewshot2' },
  'nano54-fs2-prio':  { model: 'gpt-5.4-nano', reasoning_effort: 'none', prompt: 'fewshot2', service_tier: 'priority' },
  'mini54-fs2':       { model: 'gpt-5.4-mini', reasoning_effort: 'none', prompt: 'fewshot2' },
  'mini54-fs2-prio':  { model: 'gpt-5.4-mini', reasoning_effort: 'none', prompt: 'fewshot2', service_tier: 'priority' },
  'mini41-fs2':       { model: 'gpt-4.1-mini', prompt: 'fewshot2' },
  'mini41-fs2-prio':  { model: 'gpt-4.1-mini', prompt: 'fewshot2', service_tier: 'priority' },
  'gpt55-fs2':        { model: 'gpt-5.5', reasoning_effort: 'none', prompt: 'fewshot2' },
  // --- round 3: prompt v3 ---
  'mini54-fs3-prio':  { model: 'gpt-5.4-mini', reasoning_effort: 'none', prompt: 'fewshot3', service_tier: 'priority' },
  'mini54-fs3':       { model: 'gpt-5.4-mini', reasoning_effort: 'none', prompt: 'fewshot3' }, // same as winner without priority tier (cheaper, ~+200 ms)
  'mini41-fs3-prio':  { model: 'gpt-4.1-mini', prompt: 'fewshot3', service_tier: 'priority' },
  // --- round 4: luna models vs winner ---
  'luna56-fs3':       { model: 'gpt-5.6-luna', reasoning_effort: 'none', prompt: 'fewshot3' },
  'luna56-fs3-prio':  { model: 'gpt-5.6-luna', reasoning_effort: 'none', prompt: 'fewshot3', service_tier: 'priority' },
  'luna6-fs3':        { model: 'gpt-6-luna',   reasoning_effort: 'none', prompt: 'fewshot3' },
  'luna6-fs3-prio':   { model: 'gpt-6-luna',   reasoning_effort: 'none', prompt: 'fewshot3', service_tier: 'priority' },
  // --- quality ceiling reference ---
  'gpt55-fewshot':    { model: 'gpt-5.5', reasoning_effort: 'none', prompt: 'fewshot' },
};

export const DEFAULT_ARM = process.env.DEFAULT_ARM || 'luna56-fs3-prio';
