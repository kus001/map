import { IoLayersOutline, IoCloseOutline } from "react-icons/io5";

const TYPES = [
  { id: "traffic", title: "Live traffic flow", detail: "Road speeds · green to red (TomTom key needed)", color: "#32B767" },
  { id: "incidents", title: "Traffic incidents", detail: "Collisions and lane restrictions", color: "#DC5349" },
  { id: "construction", title: "Construction & closures", detail: "Roadwork and planned restrictions", color: "#E89B3C" },
  { id: "cameras", title: "Highway cameras", detail: "Available Ontario 511 camera views", color: "#427FC7" },
  { id: "winter", title: "Winter road conditions", detail: "Reported highway surface conditions", color: "#6D8CB6" },
];

export default function LayersPanel({ open, onToggleOpen, enabled, onChange, status, darkMode }) {
  const surface = darkMode ? "border-white/15 bg-[#252b32] text-white" : "border-gray-200 bg-white text-[#25313a]";
  return (
    <div className="relative">
      <button
        type="button" onClick={onToggleOpen} aria-expanded={open} aria-label="Map layers"
        className={`flex h-11 items-center gap-2 rounded-xl border px-3 text-sm font-semibold shadow-lg backdrop-blur transition ${surface}`}
      >
        <IoLayersOutline className="text-lg" /> Layers
        {enabled.length > 0 && <span className="rounded-full bg-blue-600 px-1.5 text-[11px] text-white">{enabled.length}</span>}
      </button>
      {open && (
        <div className={`absolute bottom-full right-0 z-[1100] mb-3 w-[min(340px,calc(100vw-24px))] max-h-[min(75vh,510px)] overflow-y-auto rounded-2xl border p-4 shadow-2xl ${surface}`}>
          <div className="mb-3 flex items-center justify-between">
            <div>
              <div className="text-base font-semibold">Map layers</div>
              <div className={`text-xs ${darkMode ? "text-slate-300" : "text-slate-500"}`}>Traffic flow + Ontario 511</div>
            </div>
            <button onClick={onToggleOpen} type="button" aria-label="Close layers" className="rounded-lg p-2 hover:bg-slate-400/20"><IoCloseOutline /></button>
          </div>
          <div className="space-y-1">
            {TYPES.map(type => {
              const checked = enabled.includes(type.id);
              return (
                <label key={type.id} className="flex cursor-pointer items-start gap-3 rounded-lg px-2 py-2.5 hover:bg-slate-400/10">
                  <input type="checkbox" checked={checked}
                    onChange={() => onChange(checked ? enabled.filter(id => id !== type.id) : [...enabled, type.id])}
                    className="mt-1 h-4 w-4 accent-blue-600" />
                  <span className="mt-1 h-2.5 w-2.5 shrink-0 rounded-full" style={{ background: type.color }} />
                  <span className="min-w-0 flex-1">
                    <span className="block text-sm font-medium">{type.title}</span>
                    <span className={`block text-xs ${darkMode ? "text-slate-300" : "text-slate-500"}`}>{type.detail}</span>
                    {checked && status[type.id] && <span className="mt-1 block text-xs text-amber-500">{status[type.id]}</span>}
                  </span>
                </label>
              );
            })}
          </div>
          <div className={`mt-3 border-t pt-3 text-[11px] leading-relaxed ${darkMode ? "border-white/10 text-slate-300" : "border-gray-200 text-slate-500"}`}>
            Traffic colours show current speeds relative to normal. Road reports and cameras may be delayed.
            <a href="https://511on.ca/" target="_blank" rel="noreferrer" className="ml-1 underline">Source: Ontario 511 ↗</a>
          </div>
        </div>
      )}
    </div>
  );
}
