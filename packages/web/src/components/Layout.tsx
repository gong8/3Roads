import { Show, SignIn, UserButton } from "@clerk/react";
import type { ReactNode } from "react";
import { Outlet, Link, useLocation } from "react-router-dom";

function Nav({ account }: { account: ReactNode }) {
  const { pathname } = useLocation();

  return (
    <>
      <nav className="flex gap-4 items-center border-b border-black pb-2 mb-6">
        <Link to="/" className={pathname === "/" ? "underline" : ""}>browse</Link>
        <Link to="/generate" className={pathname === "/generate" ? "underline" : ""}>generate</Link>
        <Link to="/play" className={pathname.startsWith("/play") ? "underline" : ""}>play</Link>
        <Link to="/settings" className={`ml-auto ${pathname === "/settings" ? "underline" : ""}`}>settings</Link>
        {account}
      </nav>
      <Outlet />
    </>
  );
}

export function Layout() {
  return (
    <div className="max-w-4xl mx-auto px-4 py-6 font-mono text-sm">
      {import.meta.env.VITE_LOCAL_AUTH ? (
        // Local testing: no Clerk on the page (see main.tsx)
        <Nav account={<span className="text-xs text-gray-500 border border-gray-400 px-1">local mode</span>} />
      ) : (
        <>
          <Show when="signed-out">
            {/* Invite-only: Clerk's waitlist mode lets approved people sign in and offers the waitlist to everyone else. */}
            <div className="flex justify-center pt-12">
              <SignIn routing="hash" />
            </div>
          </Show>
          <Show when="signed-in">
            <Nav account={<UserButton />} />
          </Show>
        </>
      )}
    </div>
  );
}
