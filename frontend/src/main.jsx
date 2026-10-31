import ReactDOM from "react-dom/client";

import "leaflet/dist/leaflet.css";
import "./index.css";

import App from "./App.jsx";

console.log("Last built at:", import.meta.env.VITE_BUILD_TIME||" since this is a development, locally run session, NOW!");

ReactDOM.createRoot(document.getElementById("root")).render(<App />);
