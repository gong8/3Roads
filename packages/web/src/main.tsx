import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Route, Routes } from "react-router-dom";
import { Layout } from "./components/Layout";
import { ROUTER_BASENAME } from "./lib/base-path";
import { Browse } from "./pages/Browse";
import { GameRoom } from "./pages/GameRoom";
import { Generate } from "./pages/Generate";
import { Play } from "./pages/Play";
import { SetDetail } from "./pages/SetDetail";
import "./index.css";

const queryClient = new QueryClient();

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter basename={ROUTER_BASENAME}>
        <Routes>
          <Route element={<Layout />}>
            <Route path="/" element={<Browse />} />
            <Route path="/generate" element={<Generate />} />
            <Route path="/play" element={<Play />} />
            <Route path="/play/:roomCode" element={<GameRoom />} />
            <Route path="/sets/:id" element={<SetDetail />} />
          </Route>
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
