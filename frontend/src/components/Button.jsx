export default function Button({
  active = false,
  children,
  className = "",
  darkMode,
  ...props
}) {
  const base =
    "flex items-center justify-center rounded-lg border-2 font-semibold shadow-md transition-all duration-150 hover:-translate-y-0.5 hover:shadow-md active:translate-y-0 disabled:cursor-default disabled:opacity-50";

  const colors = active
    ? darkMode
      ? "border-blue bg-blue text-white active:bg-blue-dark active:scale-95"
      : "border-green bg-green text-white active:bg-green-dark active:scale-95"
    : darkMode
      ? "border-charcoal bg-charcoal-light text-darkmode-gray hover:border-blue hover:bg-blue active:bg-blue-dark"
      : "border-charcoal bg-charcoal text-white hover:border-green hover:bg-green active:bg-green-dark";

  return (
    <button className={`${base} ${colors} ${className}`} {...props}>
      {children}
    </button>
  );
}
