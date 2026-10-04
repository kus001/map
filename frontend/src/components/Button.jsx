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
    ? "border-green bg-green text-white active:scale-95"
    : `border-charcoal text-white hover:border-green hover:bg-green ${
        darkMode ? "bg-charcoal-light text-darkmode-gray" : "bg-charcoal"
      }`;

  return (
    <button className={`${base} ${colors} ${className}`} {...props}>
      {children}
    </button>
  );
}
