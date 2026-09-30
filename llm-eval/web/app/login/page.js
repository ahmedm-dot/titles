export const metadata = { title: 'Log in · LLM Eval' };

export default async function Login({ searchParams }) {
  const { error, next } = await searchParams;
  return (
    <div className="card login">
      <h1>Log in</h1>
      <p className="muted small">Enter the team password to see eval results.</p>
      <form method="post" action="/api/login">
        <input type="hidden" name="next" value={typeof next === 'string' ? next : '/'} />
        <label htmlFor="password" className="small">Password</label>
        <input id="password" name="password" type="password" autoComplete="current-password" required autoFocus />
        {error && <p className="error small">Wrong password. Try again.</p>}
        <button type="submit">Log in</button>
      </form>
    </div>
  );
}
