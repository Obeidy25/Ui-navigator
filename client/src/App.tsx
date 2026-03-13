import { useState } from "react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { BrowserRouter, Routes, Route, Navigate } from "react-router-dom";
import { trpc, createTRPCClient } from "./utils/trpc.js";
import Sniper from "./pages/Sniper.js";

function App() {
  const [queryClient] = useState(() => new QueryClient({
    defaultOptions: {
      queries: { retry: 2, refetchOnWindowFocus: false },
    },
  }));
  const [trpcClient] = useState(() => createTRPCClient());

  return (
    <trpc.Provider client={trpcClient} queryClient={queryClient}>
      <QueryClientProvider client={queryClient}>
        <BrowserRouter>
          <Routes>
            <Route path="/sniper" element={<Sniper />} />
            <Route path="*" element={<Navigate to="/sniper" replace />} />
          </Routes>
        </BrowserRouter>
      </QueryClientProvider>
    </trpc.Provider>
  );
}

export default App;
