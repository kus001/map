import ReactDOM from "react-dom/client";

import "leaflet/dist/leaflet.css";
import "./index.css";

import App from "./App.jsx";

console.log(import.meta.env.VITE_BUILD_TIME||"now")

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
