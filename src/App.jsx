import { Refine } from "@refinedev/core";
import { Dashboard } from "./pages/Dashboard";

function App() {
  return (
    <Refine>
      <div className="min-h-screen bg-gray-900 text-white">
        <header className="bg-gray-800 p-4 shadow-md">
          <h1 className="text-2xl font-bold text-center">Kraken Volume Monitor</h1>
        </header>
        <main>
          <Dashboard />
        </main>
      </div>
    </Refine>
  );
}

export default App;