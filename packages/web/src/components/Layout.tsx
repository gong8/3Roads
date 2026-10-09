import { Show, SignIn, UserButton } from "@clerk/react";
import { Outlet, Link, useLocation } from "react-router-dom";

export function Layout() {
  const { pathname } = useLocation();

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 font-mono text-sm">
      <Show when="signed-out">
        {/* Invite-only: Clerk's waitlist mode lets approved people sign in and offers the waitlist to everyone else. */}
        <div className="flex justify-center pt-12">
          <SignIn routing="hash" />
        </div>
      </Show>
      <Show when="signed-in">
        <nav className="flex gap-4 items-center border-b border-black pb-2 mb-6">
          <Link to="/" className={pathname === "/" ? "underline" : ""}>browse</Link>
          <Link to="/generate" className={pathname === "/generate" ? "underline" : ""}>generate</Link>
          <Link to="/play" className={pathname.startsWith("/play") ? "underline" : ""}>play</Link>
          <Link to="/settings" className={`ml-auto ${pathname === "/settings" ? "underline" : ""}`}>settings</Link>
          <UserButton />
        </nav>
        <Outlet />
      </Show>
    </div>
  );
}
