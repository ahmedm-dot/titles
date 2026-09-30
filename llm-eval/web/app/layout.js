import './globals.css';

export const metadata = { title: 'LLM Eval', description: 'GPT vs Gemini, judged by Claude, Jev and GPT' };

export default function RootLayout({ children }) {
  return (
    <html lang="en">
      <body>
        <header className="top">
          <div className="inner">
            <b>LLM Eval</b>
            <a href="/">Runs</a>
            <span className="muted small">Resume content · GPT vs Gemini · judged by Claude, Jev, GPT</span>
          </div>
        </header>
        <main>{children}</main>
      </body>
    </html>
  );
}
