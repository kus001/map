export default function Button({
    active = false,
    children,
    className = "",
    ...props
}) {
    const base = `
        flex
        items-center
        justify-center
        rounded-lg
        border-2
        font-semibold
        transition-all
        duration-200
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
            text-white
        `
        : `
            border-charcoal
            bg-charcoal
            text-white
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