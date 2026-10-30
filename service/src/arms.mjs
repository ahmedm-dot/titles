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
  // --- quality ceiling reference ---
  'gpt55-fewshot':    { model: 'gpt-5.5', reasoning_effort: 'none', prompt: 'fewshot' },
};

export const DEFAULT_ARM = process.env.DEFAULT_ARM || 'mini54-fewshot';
