import { useSearchParams } from 'react-router-dom';
import { Box, ToggleButton, ToggleButtonGroup } from '@mui/material';
import SchedulesSection from './SchedulesSection';
import RunsSection from './RunsSection';
import SkillsSection from './SkillsSection';
import RecipesSection from './RecipesSection';

const SECTIONS = [
  { value: 'schedules', label: 'Schedules' },
  { value: 'runs', label: 'Runs' },
  { value: 'directives', label: 'Directives' },
  { value: 'recipes', label: 'Recipes' }
];

export default function BulkTab() {
  const [searchParams, setSearchParams] = useSearchParams();
  // Normalize legacy 'skills' URL param to 'directives'
  const raw = searchParams.get('section');
  const sectionValue = raw === 'skills' ? 'directives' : raw;
  const section = SECTIONS.find((s) => s.value === sectionValue)?.value || 'schedules';
  const setSection = (next) => {
    const sp = new URLSearchParams(searchParams);
    sp.set('section', next);
    setSearchParams(sp, { replace: true });
  };

  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: 2 }}>
      <ToggleButtonGroup value={section} exclusive size="small" onChange={(_, v) => v && setSection(v)}>
        {SECTIONS.map((s) => (
          <ToggleButton key={s.value} value={s.value}>
            {s.label}
          </ToggleButton>
        ))}
      </ToggleButtonGroup>
      {section === 'schedules' && <SchedulesSection />}
      {section === 'runs' && <RunsSection />}
      {section === 'directives' && <SkillsSection />}
      {section === 'recipes' && <RecipesSection />}
    </Box>
  );
}
