import { Outlet, Link, useLocation } from "react-router-dom";

export function Layout() {
  const { pathname } = useLocation();

  return (
    <div className="max-w-4xl mx-auto px-4 py-6 font-mono text-sm">
      <nav className="flex gap-4 border-b border-black pb-2 mb-6">
        <Link to="/" className={pathname === "/" ? "underline" : ""}>browse</Link>
        <Link to="/generate" className={pathname === "/generate" ? "underline" : ""}>generate</Link>
      </nav>
      <Outlet />
    </div>
  );
}
