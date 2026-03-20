// Butler Design spring defaults — elegant, high-damping, no bounce
export const butlerSpring = { damping: 25, stiffness: 200 };

export const butlerStagger = { staggerChildren: 0.04 };

// Shared animation variants
export const fadeSlideUp = {
	hidden: { opacity: 0, y: 8 },
	visible: { opacity: 1, y: 0 },
};
