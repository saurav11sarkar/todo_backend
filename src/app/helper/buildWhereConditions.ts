import { IFilterParams } from './pick';

const buildWhereConditions = (
  params: IFilterParams,
  searchAbleFields: string[] = [],
  extraConditions: Record<string, any> = {},
) => {
  const { searchTerm, ...filterData } = params;

  const andConditions: any[] = [];

  if (searchTerm && searchAbleFields.length > 0) {
    andConditions.push({
      OR: searchAbleFields.map((field) => ({
        [field]: {
          contains: searchTerm,
          mode: 'insensitive',
        },
      })),
    });
  }

  if (Object.keys(filterData).length > 0) {
    andConditions.push({
      AND: Object.entries(filterData).map(([key, value]) => ({
        [key]: value,
      })),
    });
  }

  if (Object.keys(extraConditions).length > 0) {
    andConditions.push(extraConditions);
  }

  return andConditions.length > 0 ? { AND: andConditions } : {};
};

export default buildWhereConditions;
