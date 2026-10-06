import { SignIn, UserButton, useAuth } from "@clerk/react";

import { AdminPage } from "./pages/AdminPage.tsx";
import { HomePage } from "./pages/HomePage.tsx";
import { LinkPage } from "./pages/LinkPage.tsx";

export function App() {
  const { isLoaded, isSignedIn, getToken } = useAuth();
  const path = window.location.pathname;
  // A first Google sign-in becomes a sign-up, so both flows must return to the page that asked.
  const returnUrl = `${window.location.origin}${path}${window.location.search}`;

  if (!isLoaded) return null;

  return (
    <div className="page">
      <header className="header">
        <a className="brand" href="/">
          Akeru Cloud
        </a>
        {isSignedIn ? <UserButton /> : null}
      </header>
      {isSignedIn ? (
        path === "/link" ? (
          <LinkPage getToken={getToken} />
        ) : path === "/admin" ? (
          <AdminPage getToken={getToken} />
        ) : (
          <HomePage getToken={getToken} />
        )
      ) : (
        <main className="signin">
          <p className="muted">
            {path === "/link"
              ? "Sign in to link Akeru Bot to your account."
              : "Optional hosted services for Akeru Bot, such as Slack bots that work without your own tunnel."}
          </p>
          <SignIn routing="hash" forceRedirectUrl={returnUrl} signUpForceRedirectUrl={returnUrl} />
        </main>
      )}
    </div>
  );
}
