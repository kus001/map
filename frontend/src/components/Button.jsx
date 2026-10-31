export default function Button({
  active = false,
  children,
  className = "",
  darkMode,
  mapStyle,
  ...props
}) {
  const base =
    "flex items-center justify-center rounded-lg border-2 font-normal shadow-md transition-all duration-150 hover:-translate-y-0.5 focus:outline-none hover:shadow-md active:translate-y-0 disabled:cursor-default disabled:opacity-50";

  const colors = active
    ? darkMode
      ?  mapStyle === "hybrid"
        ? "border-hybrid-purple bg-hybrid-purple text-white active:scale-95"
        : mapStyle === "satellite"
          ? "border-green bg-green text-white active:border-green-dark active:bg-green-dark active:scale-95"
          : "border-blue bg-blue text-white active:bg-blue-dark active:scale-95"
      : "border-green bg-green text-white active:bg-green-dark active:scale-95"
    : darkMode
      ? mapStyle === "hybrid"
        ? "border-hybrid-charcoal bg-hybrid-charcoal-light text-darkmode-gray hover:border-hybrid-purple focus:outline-none hover:bg-hybrid-purple active:bg-hybrid-purple-dark active:border-hybrid-purple-dark"
        : mapStyle === "satellite"
          ? "border-charcoal bg-charcoal-light text-darkmode-gray hover:border-green hover:bg-green active:bg-green-dark active:border-green-dark"
          : "border-charcoal bg-charcoal-light text-darkmode-gray hover:border-blue hover:bg-blue active:bg-blue-dark active:border-blue-dark"
      : "border-charcoal bg-charcoal text-white hover:border-green hover:bg-green active:bg-green-dark active:border-green-dark"
  return (
    <button className={`${base} ${colors} ${className}`} {...props}>
      {children}
    </button>
  );
}