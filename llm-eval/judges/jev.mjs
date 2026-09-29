// Jev (TypeSafe AI) as a promptfoo judge.
// Jev isn't a chat model: it answers typed questions about a piece of content and
// returns probabilities, so it can't be used as an `llm-rubric` grader. It runs as a
// custom `javascript` assertion instead. API docs: https://docs.typesafe.ai
import { TypeSafeClient, noul, score } from '@typesafe-ai/sdk';

let client;

const QUALITY_LEVELS = [
  'Unusable: irrelevant to the job, or wrong.',
  'Weak: generic, few job keywords, little impact.',
  'Acceptable: relevant, but misses key job requirements or reads flat.',
  'Strong: well tailored, clear impact, covers most key job keywords.',
  'Excellent: recruiter-ready; tailored, specific, high impact, ATS keyword-rich.',
];
const PASS_QUALITY = 2.5; // expected score on the 0-4 scale above

export default async function jevJudge(output, context) {
  client ??= new TypeSafeClient({ timeout: 30000 }); // reads TYPESAFE_API_KEY

  const { answers } = await client.systemOne({
    state: {
      task_instructions: context.prompt,
      candidate_input: context.vars,
      ai_output: output,
    },
    questions: {
      invented: noul(
        'Does ai_output invent any experience, employer, qualification or metric that is not in candidate_input?',
      ),
      follows_format: noul(
        'Does ai_output follow the formatting rules in task_instructions (length, bullet count, no preamble)?',
      ),
      quality: score(
        'As a senior recruiter, how well does ai_output improve this candidate for the target job?',
        QUALITY_LEVELS,
      ),
    },
  });

  const invented = answers.invented.noul;
  const format = answers.follows_format.noul;
  const quality = answers.quality.score;
  const reason = `quality ${quality.toFixed(2)}/4, P(invented) ${invented.toFixed(2)}, P(format ok) ${format.toFixed(2)}`;

  return {
    pass: invented < 0.5 && format >= 0.5 && quality >= PASS_QUALITY,
    score: invented >= 0.5 ? 0 : quality / (QUALITY_LEVELS.length - 1),
    reason,
    namedScores: { judge_jev: quality / (QUALITY_LEVELS.length - 1) },
  };
}
