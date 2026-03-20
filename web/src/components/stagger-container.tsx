import { type ReactNode, Children } from "react";
import { motion, AnimatePresence } from "motion/react";
import { butlerSpring, butlerStagger, fadeSlideUp } from "@/lib/motion";

interface StaggerContainerProps {
	children: ReactNode;
	className?: string;
	style?: React.CSSProperties;
}

const containerVariants = {
	hidden: {},
	visible: {
		transition: {
			...butlerStagger,
		},
	},
};

export function StaggerContainer({ children, className, style }: StaggerContainerProps) {
	return (
		<motion.div
			className={className}
			style={style}
			variants={containerVariants}
			initial="hidden"
			animate="visible"
		>
			<AnimatePresence>
				{Children.map(children, (child, i) =>
					child ? (
						<motion.div
							key={i}
							variants={fadeSlideUp}
							transition={{ ...butlerSpring }}
						>
							{child}
						</motion.div>
					) : null,
				)}
			</AnimatePresence>
		</motion.div>
	);
}
