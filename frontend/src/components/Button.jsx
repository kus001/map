export default function Button({
    active = false,
    children,
    className = "",
    darkMode,
    ...props
}) {
    const base = `
        flex
        items-center
        justify-center
        shadow-md
        rounded-lg
        border-2
        font-semibold
        transition-all
        duration-100
        hover:-transate-y-0.5
        hover:shadow-md
        active:transate-y-0
        disabled:cursor-default
        default:opacity-50
    `;

    const colors = active
        ? `
            border-green
            bg-green
            active:scale-95
            text-white
        `
        : `
            border-charcoal
            ${darkMode ? "bg-charcoal-light text-darkmode-gray" : "bg-charcoal text-white"}
            hover:border-green
            hover:bg-green
        `;

    return (
        <button
            className={`${base} ${colors} ${className}`}
            {...props}
        >
            {children}
        </button>
    );
}