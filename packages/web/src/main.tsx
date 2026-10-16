import { ClerkProvider } from "@clerk/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { BASE_PATH, ROUTER_BASENAME } from "./lib/base-path";
import { Browse } from "./pages/Browse";
import { GameRoom } from "./pages/GameRoom";
import { Generate } from "./pages/Generate";
import { Play } from "./pages/Play";
import { SetDetail } from "./pages/SetDetail";
import { Settings } from "./pages/Settings";
import "./index.css";

const queryClient = new QueryClient();

const CLERK_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY;
if (!CLERK_KEY) throw new Error("VITE_CLERK_PUBLISHABLE_KEY is not set");

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <ClerkProvider publishableKey={CLERK_KEY} afterSignOutUrl={BASE_PATH}>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={ROUTER_BASENAME}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Browse />} />
            <Route path="/generate" element={<Generate />} />
            <Route path="/play" element={<Play />} />
            <Route path="/play/:roomCode" element={<GameRoom />} />
            <Route path="/sets/:id" element={<SetDetail />} />
            <Route path="/settings" element={<Settings />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
    </ClerkProvider>
  </StrictMode>,
);
