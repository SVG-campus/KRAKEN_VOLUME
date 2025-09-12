import { useState, useEffect } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "./components/ui/card";
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, Legend } from 'recharts';
import { ArrowUp, ArrowDown, Zap } from "lucide-react";

const getWebSocketURL = () => {
  const protocol = window.location.protocol === 'https' ? 'wss' : 'ws';
  // In dev, proxy handles this. In prod, it's the same host.
  const host = window.location.host;
  return `${protocol}://${host}`;
};

export const Dashboard = () => {
  const [data, setData] = useState([]);
  const [status, setStatus] = useState("Connecting...");

  useEffect(() => {
    const ws = new WebSocket(getWebSocketURL());

    ws.onopen = () => {
      setStatus("Connected");
      console.log("WebSocket connected");
    };

    ws.onmessage = (event) => {
      const message = JSON.parse(event.data);
      if (message.type === 'update') {
        const sortedData = message.data
          .filter(d => d.volumeVelocity !== null)
          .sort((a, b) => b.volumeVelocity - a.volumeVelocity);
        setData(sortedData);
      }
    };

    ws.onclose = () => {
      setStatus("Disconnected. Attempting to reconnect...");
      console.log("WebSocket disconnected");
      // Simple reconnect logic, you might want a more robust solution
      setTimeout(() => {
        // This will cause the useEffect to run again
        window.location.reload();
      }, 5000);
    };

    ws.onerror = (error) => {
      setStatus("Connection Error");
      console.error("WebSocket error:", error);
    };

    return () => {
      ws.close();
    };
  }, []);

  const topResult = data.length > 0 ? data[0] : null;

  return (
    <div className="p-4 md:p-8">
      <div className="mb-6 text-center">
        <p className="text-lg text-gray-400">Status: <span className="font-semibold">{status}</span></p>
        {data.length === 0 && status === 'Connected' && <p className="text-lg text-yellow-400 mt-2">Waiting for initial data from server...</p>}
      </div>

      {/* Chart for Top Pairs */}
      {data.length > 0 && (
        <Card className="mb-8 bg-gray-800 border-gray-700">
          <CardHeader>
            <CardTitle className="text-xl text-center">Volume Velocity Comparison (%/h)</CardTitle>
          </CardHeader>
          <CardContent>
            <ResponsiveContainer width="100%" height={300}>
              <BarChart data={data}>
                <XAxis dataKey="pair" stroke="#9ca3af" />
                <YAxis stroke="#9ca3af" />
                <Tooltip contentStyle={{ backgroundColor: '#374151', border: '1px solid #4b5563' }} />
                <Legend />
                <Bar dataKey="volumeVelocity" name="Volume Velocity" fill="#8884d8" />
              </BarChart>
            </ResponsiveContainer>
          </CardContent>
        </Card>
      )}

      {/* Grid of Pair Cards */}
      <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-6">
        {data.map((item, index) => (
          <Card key={item.pair} className={`bg-gray-800 border-gray-700 ${index === 0 ? 'border-2 border-purple-500' : ''}`}>
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
              <CardTitle className="text-lg font-medium">{item.pair}</CardTitle>
              {index === 0 && <span className="text-xs font-bold text-purple-400">TOP MOVER</span>}
            </CardHeader>
            <CardContent>
              <div className="text-4xl font-bold flex items-center">
                <Zap className="h-8 w-8 mr-2 text-yellow-400" />
                {item.volumeVelocity.toFixed(2)}<span className="text-lg ml-1 text-gray-400">%/h</span>
              </div>
              <p className="text-xs text-gray-400 mb-4">Volume Velocity</p>
              <div className="grid grid-cols-2 gap-4 text-sm">
                <div>
                  <p className="text-gray-400">Vol % Change</p>
                  <p className={`font-semibold flex items-center ${item.volumePctChange >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {item.volumePctChange >= 0 ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                    {item.volumePctChange.toFixed(2)}%
                  </p>
                </div>
                <div>
                  <p className="text-gray-400">Price % Change</p>
                  <p className={`font-semibold flex items-center ${item.priceChangePct >= 0 ? 'text-green-400' : 'text-red-400'}`}>
                    {item.priceChangePct >= 0 ? <ArrowUp className="h-4 w-4" /> : <ArrowDown className="h-4 w-4" />}
                    {item.priceChangePct.toFixed(2)}%
                  </p>
                </div>
              </div>
              <div className="mt-4">
                <p className="text-gray-400 text-sm">Divergence (Vol% - Price%)</p>
                <p className={`text-lg font-bold ${item.diff >= 0 ? 'text-blue-400' : 'text-orange-400'}`}>
                  {item.diff.toFixed(2)}%
                </p>
              </div>
            </CardContent>
          </Card>
        ))}
      </div>
    </div>
  );
};