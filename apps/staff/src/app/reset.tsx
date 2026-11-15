import Login from '../lib/Login';

/** Where a "forgot password" email lands (`/reset?token=…`); the sign-in screen handles it. */
export default function Reset() {
  return <Login />;
}
