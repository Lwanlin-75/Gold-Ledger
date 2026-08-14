import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App.jsx";
import "./index.css";

ReactDOM.createRoot(document.getElementById("root")).render(
  <React.StrictMode>
    <div className="min-h-screen p-4 md:p-8 flex justify-center">
      <div className="w-full max-w-4xl">
        <App />
      </div>
    </div>
  </React.StrictMode>
);
