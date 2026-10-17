import { IoLayersOutline, IoCloseOutline } from "react-icons/io5";

const layers = [
  ["traffic", "Traffic"],
  ["incidents", "Incidents"],
  ["construction", "Construction"],
  ["cameras", "Cameras"],
  ["winter", "Road conditions"],
];

function shortStatus(message) {
  if (!message) return "";
  if (/key|configure|set .*\.env/i.test(message)) return "Needs setup";
  if (/unavailable|error|failed|returned|down/i.test(message)) return "Unavailable";
  return "";
}

export default function LayersPanel({ open, onToggleOpen, enabled, onChange, status = {}, darkMode }) {
  const surface = darkMode
    ? "border-white/10 bg-[#242a31]/95 text-darkmode-gray"
    : "border-black/10 bg-white/95 text-[#1e2933]";
  const quiet = darkMode ? "text-slate-400" : "text-slate-500";
  const hover = darkMode ? "hover:bg-white/[0.06]" : "hover:bg-black/[0.035]";

  return (
    <div className="relative">
      <button
        type="button"
        onClick={onToggleOpen}
        aria-expanded={open}
        aria-label="Map layers"
        className={`flex h-11 items-center gap-2 rounded-xl border px-3 text-sm font-medium shadow-lg backdrop-blur transition-colors ${surface} ${hover}`}
      >
        <IoLayersOutline className="text-lg" aria-hidden="true" />
        Layers
        {enabled.length > 0 && (
          <span className={`ml-0.5 rounded-md px-1.5 py-0.5 text-[11px] leading-none ${darkMode ? "bg-white/15" : "bg-black/[0.07]"}`}>
            {enabled.length}
          </span>
        )}
      </button>

      {open && (
        <div
          className={`absolute bottom-full right-0 z-[1100] mb-3 w-[min(292px,calc(100vw-24px))] overflow-hidden rounded-[20px] border p-2 shadow-2xl backdrop-blur-xl ${surface}`}
        >
          <div className="flex items-center justify-between px-3 pb-1 pt-2">
            <div className="text-[15px] font-semibold tracking-[-0.015em]">Layers</div>
            <button
              type="button"
              onClick={onToggleOpen}
              aria-label="Close layers"
              className={`grid h-7 w-7 place-items-center rounded-full ${quiet} ${hover}`}
            >
              <IoCloseOutline className="text-lg" aria-hidden="true" />
            </button>
          </div>

          <div className="px-1 pb-1">
            {layers.map(([id, label], index) => {
              const checked = enabled.includes(id);
              const problem = checked ? shortStatus(status[id]) : "";
              return (
                <div key={id}>
                  {index > 0 && <div className={`mx-2 h-px ${darkMode ? "bg-white/[0.07]" : "bg-black/[0.06]"}`} />}
                  <label className={`flex min-h-[48px] cursor-pointer items-center justify-between gap-3 rounded-lg px-2.5 py-2 ${hover}`}>
                    <span className="min-w-0 flex-1">
                      <span className="block text-[13px] font-medium leading-5">{label}</span>
                      {problem && <span className={`block text-[11px] leading-4 ${quiet}`}>{problem}</span>}
                    </span>
                    <span className="relative shrink-0">
                      <input
                        type="checkbox"
                        className="peer sr-only"
                        checked={checked}
                        onChange={() => onChange(checked ? enabled.filter(value => value !== id) : [...enabled, id])}
                        aria-label={`Show ${label.toLowerCase()}`}
                      />
                      <span
                        aria-hidden="true"
                        className={`block h-[26px] w-[44px] rounded-full transition-colors duration-200 peer-focus-visible:outline peer-focus-visible:outline-2 peer-focus-visible:outline-offset-2 peer-focus-visible:outline-[#8779e7] ${checked ? "bg-[#7567dd]" : darkMode ? "bg-white/20" : "bg-[#d9dde2]"}`}
                      >
                        <span className={`absolute left-[3px] top-[3px] h-5 w-5 rounded-full bg-white shadow-sm transition-transform duration-200 ${checked ? "translate-x-[18px]" : ""}`} />
                      </span>
                    </span>
                  </label>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}