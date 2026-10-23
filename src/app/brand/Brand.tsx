interface BrandProps {
  height?: number;
}

/** TR8 wordmark, drawn as vectors so it remains independent of installed fonts. */
export default function Brand({ height = 22 }: BrandProps) {
  return (
    <svg height={height} width={Math.round((height * 109) / 40)} viewBox="0 0 109 40" role="img" aria-label="TR8">
      <path
        d="M2 2H30V9H20V38H12V9H2Z M36 2H49C59 2 65 7 65 15C65 21 62 25 57 27L67 38H57L48 28H44V38H36Z M44 9V21H49C54 21 57 19 57 15C57 11 54 9 49 9Z M89 1C99 1 105 5 105 12C105 16 103 19 99 20C104 22 107 25 107 29C107 36 100 40 89 40C78 40 72 36 72 29C72 25 75 22 79 20C75 18 73 16 73 12C73 5 79 1 89 1Z M89 8C84 8 81 10 81 13C81 16 84 18 89 18C94 18 97 16 97 13C97 10 94 8 89 8Z M89 24C83 24 80 26 80 29C80 32 83 34 89 34C95 34 99 32 99 29C99 26 95 24 89 24Z"
        fill="currentColor"
        fillRule="evenodd"
      />
    </svg>
  );
}
