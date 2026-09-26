import { MapContainer, TileLayer, Marker } from "react-leaflet";
import "leaflet/dist/leaflet.css";

function MapView() {
    return (        
        <MapContainer center={[43.482956657064555, -80.52492558312194]} zoom={13} scrollWheelZoom={true} className="h-full w-full">
          <TileLayer
            attribution='&copy; <a href="https://www.openstreetmap.org/copyright">OpenStreetMap</a> contributors'
            url="https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png"
          />
          <Marker position={[43.482956657064555, -80.52492558312194]}>
          </Marker>
        </MapContainer>
    )
}

export default MapView;