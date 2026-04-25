/**
 * Common panel chrome — a bordered box with a colored title row. Reused by
 * WavePanel / DetectorPanel / ReviewPanel / EventLog so they share the same
 * visual rhythm without each panel re-implementing the frame.
 */

import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { COLORS } from "../theme.ts";

interface Props {
	title: string;
	titleColor?: string;
	flexGrow?: number;
	flexBasis?: number | string;
	minWidth?: number;
	children: ReactNode;
}

export function PanelFrame({
	title,
	titleColor,
	flexGrow,
	flexBasis,
	minWidth,
	children,
}: Props): React.ReactElement {
	return (
		<Box
			flexDirection="column"
			borderStyle="round"
			borderColor={COLORS.muted}
			paddingX={1}
			flexGrow={flexGrow}
			flexBasis={flexBasis}
			minWidth={minWidth}
		>
			<Box marginBottom={1}>
				<Text bold color={titleColor ?? COLORS.primary}>
					{title}
				</Text>
			</Box>
			{children}
		</Box>
	);
}
