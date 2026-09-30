// DEMO ONLY: canned "GPT" and "Gemini" outputs, so the demo needs no API keys.
const CANNED = {
  GPT: {
    analyst_summary: 'Statistics graduate with hands-on SQL and Python (pandas) experience from a RetailCo internship. Built an Excel sales dashboard used by 3 store managers and prepared survey data for analysis. Ready to bring analytical rigour to dashboards and A/B test analysis for product teams.',
    analyst_bullets: '- Wrote weekly SQL queries to extract sales data for store performance reporting\n- Built an Excel dashboard used by 3 store managers to track weekly sales\n- Cleaned and prepared survey data in Python (pandas) for analysis',
    nurse_summary: 'Registered nurse with 9 years in acute medical wards, including 5 years as Senior Staff Nurse leading shifts of 8 nurses. Mentored 12 student nurses and led a falls-prevention project that reduced falls by 30%. Ready to lead a ward team on patient safety, rostering and training.',
    nurse_bullets: '- Led shifts of 8 nurses on an acute medical ward, coordinating patient safety and staffing\n- Mentored 12 student nurses, supporting training for new starters\n- Led a falls-prevention project that reduced patient falls by 30%',
  },
  Gemini: {
    analyst_summary: 'Data-driven statistics graduate who delivered SQL and Python analytics at RetailCo, including a Tableau dashboard that improved sales insight by 25%. Skilled at partnering with product teams and running A/B tests.',
    analyst_bullets: '- Engineered SQL queries to extract weekly sales data for reporting\n- Designed an Excel dashboard used by 3 store managers\n- Cleaned survey data with Python to enable accurate analysis',
    nurse_summary: 'Registered nurse with 9 years of acute medical experience. I have a proven record in patient safety, cutting falls by 30% through a project I led, and I have mentored 12 student nurses. Ready to manage ward staff rostering, training and compliance.',
    nurse_bullets: '- Supervised shift teams of 8 nurses across a 40-bed medical ward\n- Mentored and trained 12 student nurses as new starters\n- Spearheaded a falls-prevention initiative, reducing falls by 30% and saving £50k',
  },
};

export default class MockGenerator {
  constructor(options) {
    this.model = options.config?.model;
    this.label = options.label;
  }
  id() {
    return `demo:${this.model}`;
  }
  async callApi(prompt) {
    const who = prompt.includes('Clinical Nurse Manager') ? 'nurse' : 'analyst';
    const what = prompt.includes('Original bullets') ? 'bullets' : 'summary';
    await new Promise((r) => setTimeout(r, 150 + Math.random() * 400));
    const output = CANNED[this.model][`${who}_${what}`];
    return { output, tokenUsage: { prompt: 350, completion: 90, total: 440 }, cost: this.model === 'GPT' ? 0.0021 : 0.0014 };
  }
}
